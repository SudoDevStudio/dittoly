import { guideOfModule, type Generation } from '../modules/registry.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit } from '../core/audit.js';
import type { Cipher } from '../core/crypto.js';
import { AppError, badRequest, forbidden, notFound } from '../core/errors.js';
import { errorType, log } from '../core/log.js';
import type { Member } from '../core/members.js';
import { assertTeamAdmin } from '../core/teams.js';
import type { Db, Queryable } from '../db/db.js';
import { enqueue, type Job } from '../engine/jobs.js';
import { slugify } from '../export/bundle.js';
import type { FetchLike } from '../runtime/broker.js';
import { GitError, parseRepoUrl, remoteFor, type Provider, type RepoFile } from './remote.js';
import { importSnapshot } from './import.js';
import type { App } from '../app.js';
import { scaffoldFiles } from './scaffold.js';

/**
 * Git sync, Dittoly → git: every approved module, Flow (Super Flows too) and app version is written to the
 * connected repository as files, on a branch of its own, with a pull (merge) request for people to review and merge.
 * - The organization connects one repository; a team may connect its own, which takes its Flows and apps.
 *   Modules belong to the organization, so they go to the organization's repository.
 * - Without a connection nothing is synced.
 * - Approvals, run history and secrets never go to git: only what was approved (definitions, manifests, code,
 *   tests, layouts).
 */

export const connectionBody = z
  .object({
    teamId: z.string().uuid().nullable().default(null),
    provider: z.enum(['github', 'gitlab', 'git']),
    repoUrl: z.string().trim().max(500),
    branch: z.string().trim().regex(/^[\w./-]{1,100}$/).refine((b) => !b.includes('..') && !b.startsWith('/') && !b.endsWith('/'), 'not a branch name').default('main'),
    folder: z.string().trim().regex(/^[\w.-]+(\/[\w.-]+)*$/).max(100).refine((f) => !f.split('/').includes('..'), 'not a folder').default('dittoly'),
    /** Required when connecting; left out to keep the stored one. */
    token: z.string().min(1).max(500).optional(),
  })
  .strict();

type Kind = 'module' | 'flow' | 'app';
interface ConnectionRow { id: string; team_id: string | null; provider: Provider; repo_url: string; branch: string; folder: string; token_enc: string; created_by: string; created_at: Date; updated_at: Date }

const aad = (id: string) => `git-connection:${id}`;
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export class GitSync {
  constructor(
    private readonly d: { db: Db; cipher: Cipher; fetch: FetchLike; internalHosts: readonly string[]; allowFileRemote?: boolean; app: () => App },
  ) {}

  private remote(c: ConnectionRow) {
    return remoteFor(c.provider, c.repo_url, this.d.cipher.decrypt(c.token_enc, aad(c.id)), { fetch: this.d.fetch, internalHosts: this.d.internalHosts, allowFileRemote: this.d.allowFileRemote });
  }

  /** Org admins manage the organization's connection; a team's admins (and org admins) manage the team's. */
  private async assertManager(db: Queryable, actor: Member, teamId: string | null) {
    if (teamId === null) {
      if (actor.role !== 'admin') throw forbidden('admin_only');
    } else await assertTeamAdmin(db, teamId, actor);
  }

  private view(c: ConnectionRow) {
    return { id: c.id, teamId: c.team_id, provider: c.provider, repoUrl: c.repo_url, branch: c.branch, folder: c.folder, createdBy: c.created_by, updatedAt: c.updated_at };
  }

  /** The connection of a scope (the organization when teamId is null), with its recent exports; null when none. */
  async get(actor: Member, teamId: string | null) {
    await this.assertManager(this.d.db, actor, teamId);
    const c = (await this.d.db.query<ConnectionRow>(`SELECT * FROM git_connections WHERE team_id IS NOT DISTINCT FROM $1`, [teamId])).rows[0];
    if (!c) return null;
    const exports = (
      await this.d.db.query<{ id: string; kind: string; title: string; status: string; branch: string | null; url: string | null; error: string | null; created_at: Date; updated_at: Date }>(
        `SELECT id, kind, title, status, branch, url, error, created_at, updated_at FROM git_exports WHERE connection_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [c.id],
      )
    ).rows;
    const imports = (
      await this.d.db.query<{ id: string; commit_sha: string | null; status: string; created: unknown; problems: string[]; created_at: Date }>(
        `SELECT id, commit_sha, status, created, problems, created_at FROM git_imports WHERE connection_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [c.id],
      )
    ).rows.map((r) => ({ id: r.id, commit: r.commit_sha, status: r.status, created: r.created, problems: r.problems, createdAt: r.created_at }));
    return { ...this.view(c), lastImportAt: (c as ConnectionRow & { last_import_at: Date | null }).last_import_at, imports, exports: exports.map((e) => ({ id: e.id, kind: e.kind, title: e.title, status: e.status, branch: e.branch, url: e.url, error: e.error, createdAt: e.created_at, updatedAt: e.updated_at })) };
  }

  /** Connect (or change) a scope's repository. The token is checked against the repository before it is kept. */
  async save(actor: Member, raw: unknown) {
    const parsed = connectionBody.safeParse(raw);
    if (!parsed.success) throw badRequest('invalid_git_connection', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    const b = parsed.data;
    await this.assertManager(this.d.db, actor, b.teamId);
    // Tests push to local file:// repositories.
    if (!(this.d.allowFileRemote && b.repoUrl.startsWith('file://'))) parseRepoUrl(b.repoUrl);
    const existing = (await this.d.db.query<ConnectionRow>(`SELECT * FROM git_connections WHERE team_id IS NOT DISTINCT FROM $1`, [b.teamId])).rows[0];
    if (!existing && !b.token) throw badRequest('token_required', 'a token with write access to the repository is needed to connect it');
    const id = existing?.id ?? randomUUID();
    const tokenEnc = b.token ? this.d.cipher.encrypt(b.token, aad(id)) : existing!.token_enc;
    const candidate: ConnectionRow = { id, team_id: b.teamId, provider: b.provider, repo_url: b.repoUrl, branch: b.branch, folder: b.folder, token_enc: tokenEnc, created_by: existing?.created_by ?? actor.id, created_at: existing?.created_at ?? new Date(), updated_at: new Date() };
    await this.remote(candidate).check(b.branch);
    await this.d.db.query(
      `INSERT INTO git_connections (id, team_id, provider, repo_url, branch, folder, token_enc, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, repo_url = EXCLUDED.repo_url, branch = EXCLUDED.branch, folder = EXCLUDED.folder,
         token_enc = EXCLUDED.token_enc, updated_at = now()`,
      [id, b.teamId, b.provider, b.repoUrl, b.branch, b.folder, tokenEnc, actor.id],
    );
    await audit(this.d.db, { actorId: actor.id, action: existing ? 'git.connection_updated' : 'git.connected', subjectType: b.teamId ? 'team' : 'org', subjectId: b.teamId ?? id, outcome: 'ok', relatedId: id });
    return this.get(actor, b.teamId);
  }

  async remove(actor: Member, id: string) {
    const c = (await this.d.db.query<ConnectionRow>(`SELECT * FROM git_connections WHERE id = $1`, [id])).rows[0];
    if (!c) throw notFound('git_connection');
    await this.assertManager(this.d.db, actor, c.team_id);
    await this.d.db.query(`DELETE FROM git_connections WHERE id = $1`, [id]);
    await audit(this.d.db, { actorId: actor.id, action: 'git.disconnected', subjectType: c.team_id ? 'team' : 'org', subjectId: c.team_id ?? id, outcome: 'ok', relatedId: id });
  }

  /** Write everything approved now (for this scope) as one pull request: the first sync, or catching up. */
  async exportAll(actor: Member, id: string) {
    const c = (await this.d.db.query<ConnectionRow>(`SELECT * FROM git_connections WHERE id = $1`, [id])).rows[0];
    if (!c) throw notFound('git_connection');
    await this.assertManager(this.d.db, actor, c.team_id);
    const row = (await this.d.db.query<{ id: string }>(`INSERT INTO git_exports (connection_id, kind, title, status) VALUES ($1, 'all', $2, 'pending') RETURNING id`, [id, 'Everything approved in Dittoly'])).rows[0]!;
    await enqueue(this.d.db, 'git_export_all', { exportId: row.id });
    await audit(this.d.db, { actorId: actor.id, action: 'git.export_all_requested', subjectType: c.team_id ? 'team' : 'org', subjectId: c.team_id ?? id, outcome: 'ok', relatedId: row.id });
    return { exportId: row.id };
  }

  /** Try a failed export again. */
  async retry(actor: Member, exportId: string) {
    const e = (await this.d.db.query<{ connection_id: string; kind: string; version_id: string | null; status: string }>(`SELECT connection_id, kind, version_id, status FROM git_exports WHERE id = $1`, [exportId])).rows[0];
    if (!e) throw notFound('git_export');
    const c = (await this.d.db.query<ConnectionRow>(`SELECT * FROM git_connections WHERE id = $1`, [e.connection_id])).rows[0]!;
    await this.assertManager(this.d.db, actor, c.team_id);
    if (e.status !== 'failed') throw badRequest('git_export_not_failed');
    await this.d.db.query(`UPDATE git_exports SET status = 'pending', error = NULL, updated_at = now() WHERE id = $1`, [exportId]);
    await enqueue(this.d.db, e.kind === 'all' ? 'git_export_all' : 'git_export', e.kind === 'all' ? { exportId } : { kind: e.kind, versionId: e.version_id! });
  }

  /** Read the branch now (it is also read every few minutes): merged changes become versions waiting for approval. */
  async syncNow(actor: Member, id: string) {
    const c = (await this.d.db.query<ConnectionRow>(`SELECT * FROM git_connections WHERE id = $1`, [id])).rows[0];
    if (!c) throw notFound('git_connection');
    await this.assertManager(this.d.db, actor, c.team_id);
    await enqueue(this.d.db, 'git_import', { connectionId: id, force: 'true' });
  }

  /** Every few minutes, each connection's branch is read once (maintenance). */
  async scheduleImports(now = new Date()) {
    const due = (await this.d.db.query<{ id: string }>(
      `UPDATE git_connections SET last_import_at = $1 WHERE last_import_at IS NULL OR last_import_at < $1::timestamptz - interval '10 minutes' RETURNING id`,
      [now],
    )).rows;
    for (const r of due) await enqueue(this.d.db, 'git_import', { connectionId: r.id });
  }

  // ---- jobs

  async handleJob(job: Job): Promise<void> {
    if (job.kind === 'git_export') await this.exportVersion(job.payload.kind as Kind, job.payload.versionId!);
    else if (job.kind === 'git_export_all') await this.runExportAll(job.payload.exportId!);
    else if (job.kind === 'git_import') await this.runImport(job.payload.connectionId!, job.payload.force === 'true');
  }

  private async runImport(id: string, force: boolean) {
    const c = (await this.d.db.query<ConnectionRow & { last_import_commit: string | null }>(`SELECT * FROM git_connections WHERE id = $1`, [id])).rows[0];
    if (!c) return;
    // A change held back last time is read again even when nothing new was merged.
    const waiting = (await this.d.db.query(`SELECT 1 FROM git_import_files WHERE connection_id = $1 AND waiting_sha IS NOT NULL LIMIT 1`, [id])).rowCount! > 0;
    const reread = force || waiting;
    let commit: string | null = null;
    try {
      const snap = await this.remote(c).snapshot(c.branch, c.folder, reread ? null : c.last_import_commit);
      commit = snap.commit;
      // The same commit as last time, and nothing held back: nothing new was merged.
      if (!reread && snap.commit === c.last_import_commit) return;
      const result = await importSnapshot(this.d.app(), c, snap);
      await this.d.db.query(`UPDATE git_connections SET last_import_commit = $2, last_import_at = now() WHERE id = $1`, [id, snap.commit]);
      if (result.created.length || result.problems.length) {
        await this.d.db.query(`INSERT INTO git_imports (connection_id, commit_sha, status, created, problems) VALUES ($1, $2, 'imported', $3, $4)`, [id, snap.commit, JSON.stringify(result.created), result.problems.slice(0, 50)]);
        await audit(this.d.db, { actorId: null, action: 'git.imported', subjectType: c.team_id ? 'team' : 'org', subjectId: c.team_id ?? id, outcome: result.problems.length ? 'failed' : 'ok', relatedId: id });
      }
    } catch (err) {
      const message = err instanceof AppError ? (err.message !== err.code ? `${err.code}: ${err.message}` : err.code) : 'git_import_failed';
      log.warn('git_import_failed', { errorType: errorType(err) });
      await this.d.db.query(`INSERT INTO git_imports (connection_id, commit_sha, status, problems) VALUES ($1, $2, 'failed', $3)`, [id, commit, [message.slice(0, 500)]]);
      if (!(err instanceof AppError)) throw err;
    }
  }

  /** Where a version goes: modules to the organization's repository; Flows and apps to their team's, else the organization's. */
  private async connectionFor(kind: Kind, teamId: string | null): Promise<ConnectionRow | null> {
    const rows = (await this.d.db.query<ConnectionRow>(`SELECT * FROM git_connections WHERE team_id IS NULL OR team_id = $1`, [kind === 'module' ? null : teamId])).rows;
    return rows.find((r) => r.team_id !== null) ?? rows.find((r) => r.team_id === null) ?? null;
  }

  private async exportVersion(kind: Kind, versionId: string) {
    const item = await this.item(kind, versionId);
    if (!item) return;
    const c = await this.connectionFor(kind, item.teamId);
    if (!c) return;
    // One export per version and repository; a retry reuses the row.
    await this.d.db.query(
      `INSERT INTO git_exports (connection_id, kind, version_id, title, status) VALUES ($1, $2, $3, $4, 'pending') ON CONFLICT (connection_id, kind, version_id) WHERE version_id IS NOT NULL DO NOTHING`,
      [c.id, kind, versionId, item.title],
    );
    const row = (await this.d.db.query<{ id: string; status: string }>(`SELECT id, status FROM git_exports WHERE connection_id = $1 AND kind = $2 AND version_id = $3`, [c.id, kind, versionId])).rows[0]!;
    if (row.status !== 'pending') return;
    await this.publish(c, row.id, item.files(c.folder), `dittoly/${kind}-${item.slug}-v${item.version}`, `Dittoly: ${item.title}`);
  }

  private async runExportAll(exportId: string) {
    const e = (await this.d.db.query<{ connection_id: string; status: string }>(`SELECT connection_id, status FROM git_exports WHERE id = $1`, [exportId])).rows[0];
    if (!e || e.status !== 'pending') return;
    const c = (await this.d.db.query<ConnectionRow>(`SELECT * FROM git_connections WHERE id = $1`, [e.connection_id])).rows[0];
    if (!c) return;
    // The repository's TypeScript project (README, package.json, types, schemas, build script), then the content.
    const files: RepoFile[] = await scaffoldFiles(c.folder);
    const others = (await this.d.db.query<{ team_id: string }>(`SELECT team_id FROM git_connections WHERE team_id IS NOT NULL`)).rows.map((r) => r.team_id);
    if (c.team_id === null) {
      // Each module's newest approved version.
      const mods = (await this.d.db.query<{ id: string }>(
        `SELECT DISTINCT ON (name) id FROM module_versions WHERE status = 'approved' AND name NOT IN (SELECT name FROM module_archive) ORDER BY name, created_at DESC`,
      )).rows;
      for (const m of mods) files.push(...((await this.item('module', m.id))?.files(c.folder) ?? []));
    }
    // Flows and apps of this team, or (for the organization) of every team without a connection of its own.
    const teamFilter = c.team_id === null ? `NOT (f.team_id = ANY($1::uuid[]))` : `f.team_id = $1::uuid`;
    const param = c.team_id === null ? others : c.team_id;
    const flows = (await this.d.db.query<{ id: string }>(`SELECT v.id FROM flow_versions v JOIN flows f ON f.id = v.flow_id WHERE v.status = 'approved' AND f.archived_at IS NULL AND ${teamFilter}`, [param])).rows;
    for (const f of flows) files.push(...((await this.item('flow', f.id))?.files(c.folder) ?? []));
    const apps = (await this.d.db.query<{ id: string }>(`SELECT v.id FROM app_versions v JOIN apps f ON f.id = v.app_id WHERE v.status = 'approved' AND f.archived_at IS NULL AND ${teamFilter}`, [param])).rows;
    for (const a of apps) files.push(...((await this.item('app', a.id))?.files(c.folder) ?? []));
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
    await this.publish(c, exportId, files, `dittoly/sync-${stamp}`, 'Dittoly: everything approved');
  }

  private async publish(c: ConnectionRow, exportId: string, files: RepoFile[], branch: string, title: string) {
    const body = 'Written by Dittoly from approved versions. Approvals, run history and secrets are not included.\n\nMerge it to keep this repository in step with Dittoly. Changes merged later come back to Dittoly as versions that wait for approval there.';
    try {
      const out = await this.remote(c).publish({ files, base: c.branch, branch, title, body });
      await this.d.db.query(`UPDATE git_exports SET status = $2, branch = $3, url = $4, error = NULL, updated_at = now() WHERE id = $1`, [
        exportId,
        out.unchanged ? 'unchanged' : out.url ? 'opened' : 'pushed',
        out.unchanged ? null : out.branch,
        out.url,
      ]);
    } catch (err) {
      // A refused token or a missing repository needs a person, not a retry: the failure is shown with a Retry button.
      const message = err instanceof AppError ? (err.message !== err.code ? `${err.code}: ${err.message}` : err.code) : 'git_export_failed';
      log.warn('git_export_failed', { errorType: errorType(err) });
      await this.d.db.query(`UPDATE git_exports SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [exportId, message.slice(0, 500)]);
      if (!(err instanceof GitError) && !(err instanceof AppError)) throw err;
    }
  }

  /** An approved version as files, with its team (null for modules) and a title. */
  private async item(kind: Kind, versionId: string): Promise<{ teamId: string | null; title: string; slug: string; version: string | number; files: (folder: string) => RepoFile[] } | null> {
    const db = this.d.db;
    if (kind === 'module') {
      const m = (await db.query<{ name: string; version: string; manifest: unknown; code: string; source: string | null; tests: unknown; status: string; generation: Generation | null }>(`SELECT name, version, manifest, code, source, tests, status, generation FROM module_versions WHERE id = $1`, [versionId])).rows[0];
      if (!m || m.status !== 'approved') return null;
      return {
        teamId: null,
        title: `module ${m.name} ${m.version}`,
        slug: m.name,
        version: m.version,
        files: (folder) => [
          { path: `${folder}/modules/${m.name}/manifest.json`, content: json(m.manifest) },
          // The TypeScript when the module has it (Dittoly compiles it when it reads it back), else the JavaScript.
          // Only one of the two is ever in the folder.
          { path: `${folder}/modules/${m.name}/module.ts`, content: m.source === null ? null : withNewline(m.source) },
          { path: `${folder}/modules/${m.name}/module.mjs`, content: m.source === null ? withNewline(m.code) : null },
          { path: `${folder}/modules/${m.name}/tests.json`, content: json(m.tests) },
          // What it does and how to use it (written by Dittoly from the manifest, with the builder's notes).
          { path: `${folder}/modules/${m.name}/MODULE.md`, content: guideOfModule(m) },
        ],
      };
    }
    if (kind === 'flow') {
      const v = (await db.query<{ version: number; status: string; definition: { steps: { type: string; runs?: { flow: string; version: number }[] }[] }; name: string; team_id: string; team: string }>(
        `SELECT v.version, v.status, v.definition, f.name, f.team_id, t.name AS team FROM flow_versions v JOIN flows f ON f.id = v.flow_id JOIN teams t ON t.id = f.team_id WHERE v.id = $1`,
        [versionId],
      )).rows[0];
      if (!v || v.status !== 'approved') return null;
      // A Super Flow names the Flows it runs, so the file reads (and imports) without Dittoly's ids.
      const refs = [...new Map(v.definition.steps.flatMap((s) => (s.type === 'flow' ? (s.runs ?? []) : [])).map((r) => [`${r.flow}@${r.version}`, r])).values()];
      const children: { flowId: string; version: number; name: string | null; team: string | null }[] = [];
      for (const r of refs) {
        const child = (await db.query<{ name: string; team: string }>(`SELECT f.name, t.name AS team FROM flows f JOIN teams t ON t.id = f.team_id WHERE f.id = $1`, [r.flow])).rows[0];
        children.push({ flowId: r.flow, version: r.version, name: child?.name ?? null, team: child?.team ?? null });
      }
      const slug = slugify(v.name, 'flow');
      const superFlow = refs.length > 0;
      const guide = await this.d.app().flows.guide(db, versionId);
      return {
        teamId: v.team_id,
        title: `${superFlow ? 'Super Flow' : 'Flow'} "${v.name}" v${v.version}`,
        slug,
        version: v.version,
        files: (folder) => [
          { path: `${folder}/flows/${slugify(v.team, 'team')}/${slug}/flow.json`, content: json({ format: 'dittoly-flow', formatVersion: 1, name: v.name, team: v.team, version: v.version, definition: v.definition, children }) },
          // What it does and how; a Super Flow's covers every Flow it runs and the modules under them.
          { path: `${folder}/flows/${slugify(v.team, 'team')}/${slug}/FLOW.md`, content: guide },
        ],
      };
    }
    const a = (await db.query<{ version: number; status: string; spec: { flows: { flowId: string }[]; plan: unknown; brand?: unknown }; name: string; team_id: string; team: string }>(
      `SELECT v.version, v.status, v.spec, a.name, a.team_id, t.name AS team FROM app_versions v JOIN apps a ON a.id = v.app_id JOIN teams t ON t.id = a.team_id WHERE v.id = $1`,
      [versionId],
    )).rows[0];
    if (!a || a.status !== 'approved') return null;
    const flows: { flowId: string; name: string | null }[] = [];
    for (const f of a.spec.flows) flows.push({ flowId: f.flowId, name: (await db.query<{ name: string }>(`SELECT name FROM flows WHERE id = $1`, [f.flowId])).rows[0]?.name ?? null });
    const slug = slugify(a.name, 'app');
    return {
      teamId: a.team_id,
      title: `app "${a.name}" v${a.version}`,
      slug,
      version: a.version,
      files: (folder) => [{ path: `${folder}/apps/${slugify(a.team, 'team')}/${slug}/app.json`, content: json({ format: 'dittoly-app', formatVersion: 1, name: a.name, team: a.team, version: a.version, flows, plan: a.spec.plan, brand: a.spec.brand ?? null }) }],
    };
  }
}

const withNewline = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);

