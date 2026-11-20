import type { App } from '../app.js';
import { AppError } from '../core/errors.js';
import type { Member } from '../core/members.js';
import { slugify } from '../export/bundle.js';
import { bumpPatch, cmpVersions } from '../modules/chat.js';
import { canonicalJson, sha256Hex } from '../runtime/crypto.js';
import { createApp, updateApp } from '../team-apps/service.js';
import type { Snapshot } from './remote.js';

/**
 * Git sync, git → Dittoly: what is merged into the connected branch comes back as new versions that wait for
 * approval in Dittoly. Git never approves anything.
 * - Each file (a module's folder counts as one) is handled once per change: what was last handled is kept per
 *   connection (git_import_files), so reading the same branch again does nothing.
 * - What Dittoly wrote never comes back: content that matches the version it already has, or a newer one (its own
 *   pull request was merged), is not a change. Going back to an older version on purpose is: it becomes a new
 *   pending version with that content; the old approval never carries over.
 * - A change held back (another version waits for a decision, a Flow it runs is not here yet) is read again on the
 *   next reads, without needing another commit, until it is handled.
 * - A change to an existing Flow is proposed as its owner's, and the approved version keeps running until the change
 *   is approved (as a self-fix is). A change to an app is a new pending version of it; its live version stays live.
 * - A module change is a new module version, sandbox-tested and sent for an admin's review.
 * - New files make new Flows, apps and modules (pending). Deleting a file deletes nothing.
 * - Only what the connection covers: a team's repository changes that team's Flows and apps; the organization's
 *   changes modules, and the Flows and apps of teams without a repository of their own.
 */

export interface ImportConnection { id: string; team_id: string | null; folder: string; created_by: string }
export interface ImportResult { created: { kind: 'module' | 'flow' | 'app'; name: string; version: string | number; id: string }[]; problems: string[] }

/** What was last handled for one file (or module folder). */
interface Seen { sha256: string | null; version: string | null; waiting_sha: string | null }
/** Applying a change: a new version, held back to be read again, or a problem that only a new change fixes. */
type Outcome = { created: ImportResult['created'][number] } | { held: string } | { problem: string };
const held = (message: string): Outcome => ({ held: message });
const problem = (message: string): Outcome => ({ problem: message });

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const reason = (err: unknown) => (err instanceof AppError ? (err.message !== err.code ? `${err.code}: ${err.message}` : err.code) : 'failed');

export async function importSnapshot(app: App, c: ImportConnection, snap: Snapshot): Promise<ImportResult> {
  const out: ImportResult = { created: [], problems: [] };
  const db = app.db;
  const member = async (id: string) => (await db.query<Member>(`SELECT id, handle, role FROM members WHERE id = $1 AND NOT disabled`, [id])).rows[0] ?? null;
  const connector = await member(c.created_by);
  if (!connector) {
    out.problems.push('the person who connected the repository is no longer a member: connect it again');
    return out;
  }
  const prefix = `${c.folder}/`;
  const git = (path: string) => ({ commit: snap.commit, path });

  const seen = new Map((await db.query<Seen & { path: string }>(`SELECT path, sha256, version, waiting_sha FROM git_import_files WHERE connection_id = $1`, [c.id])).rows.map((r) => [r.path, r as Seen]));
  const settle = (key: string, sha: string, version: string | null) =>
    db.query(
      `INSERT INTO git_import_files (connection_id, path, sha256, version) VALUES ($1, $2, $3, $4)
       ON CONFLICT (connection_id, path) DO UPDATE SET sha256 = $3, version = $4, waiting_sha = NULL, updated_at = now()`,
      [c.id, key, sha, version],
    );
  const hold = (key: string, sha: string) =>
    db.query(
      `INSERT INTO git_import_files (connection_id, path, waiting_sha) VALUES ($1, $2, $3)
       ON CONFLICT (connection_id, path) DO UPDATE SET waiting_sha = $3, updated_at = now()`,
      [c.id, key, sha],
    );
  const present = new Set<string>();

  /**
   * One file's content: unchanged since it was last handled → nothing; it matches the version Dittoly has, or a
   * newer one → recorded, nothing else; anything else (new content, or an older version on purpose) → applied.
   * `match` is the Dittoly version with exactly this content; `order` compares two versions.
   */
  const handle = async (
    key: string,
    content: unknown,
    u: { invalid?: string; match?: () => Promise<string | null>; order?: (a: string, b: string) => number; apply?: () => Promise<Outcome> },
  ) => {
    present.add(key);
    const sha = sha256Hex(canonicalJson(content));
    const prev = seen.get(key);
    if (prev?.sha256 === sha) {
      if (prev.waiting_sha) await settle(key, sha, prev.version);
      return;
    }
    if (u.invalid) {
      if (prev?.waiting_sha !== sha) out.problems.push(u.invalid);
      await settle(key, sha, null);
      return;
    }
    const match = await u.match!();
    const back = match !== null && prev?.version != null && u.order!(match, prev.version) < 0;
    if (match !== null && !back) {
      await settle(key, sha, match);
      return;
    }
    let r: Outcome;
    try {
      r = await u.apply!();
    } catch (err) {
      r = problem(reason(err));
    }
    if ('created' in r) {
      out.created.push(r.created);
      await settle(key, sha, String(r.created.version));
    } else if ('held' in r) {
      if (prev?.waiting_sha !== sha) out.problems.push(r.held);
      await hold(key, sha);
    } else {
      out.problems.push(r.problem);
      await settle(key, sha, null);
    }
  };

  // Teams this connection covers, by the folder name an export gives them.
  const own = new Set((await db.query<{ team_id: string }>(`SELECT team_id FROM git_connections WHERE team_id IS NOT NULL`)).rows.map((r) => r.team_id));
  const teams = (await db.query<{ id: string; name: string }>(`SELECT id, name FROM teams`)).rows;
  const teamFor = (slug: string): string | null => {
    if (c.team_id) return c.team_id;
    return teams.find((t) => slugify(t.name, 'team') === slug && !own.has(t.id))?.id ?? null;
  };
  const byNumber = (a: string, b: string) => Number(a) - Number(b);

  // ---- modules (the organization's repository only)
  if (c.team_id === null) {
    const groups = new Map<string, Record<string, string>>();
    for (const [path, text] of snap.files) {
      const m = new RegExp(`^${escape(prefix)}modules/([^/]+)/(manifest\\.json|module\\.ts|module\\.mjs|tests\\.json)$`).exec(path);
      if (m) groups.set(m[1]!, { ...(groups.get(m[1]!) ?? {}), [m[2]!]: text });
    }
    for (const [name, files] of groups) {
      const where = `${prefix}modules/${name}/`;
      const manifest = files['manifest.json'] ? parse(files['manifest.json']) : undefined;
      // The module's TypeScript (Dittoly compiles it), or JavaScript for a module written that way: one of the two.
      const source = files['module.ts'];
      const js = files['module.mjs'];
      const code = source ?? js;
      const tests = files['tests.json'] ? parse(files['tests.json']) : [];
      const invalid = !isObject(manifest) || code === undefined
        ? `${where}: needs a manifest.json (valid JSON) and a module.ts`
        : source !== undefined && js !== undefined
          ? `${where}: has both module.ts and module.mjs; keep only module.ts`
          : manifest.name !== name
          ? `${where}manifest.json: its name must be "${name}", like its folder`
          : !Array.isArray(tests)
            ? `${where}tests.json: must be a list of tests`
            : undefined;
      if (invalid || !isObject(manifest) || code === undefined || !Array.isArray(tests)) {
        await handle(where, files, { invalid: invalid ?? 'invalid' });
        continue;
      }
      const versions = async () => (await db.query<{ version: string; manifest: Record<string, unknown>; code_sha256: string; source_sha256: string | null; tests: unknown; status: string }>(
        `SELECT version, manifest, code_sha256, source_sha256, tests, status FROM module_versions WHERE name = $1`,
        [name],
      )).rows;
      // A module's content: its code (the TypeScript, or the JavaScript), its manifest (whatever version it names) and its tests.
      const shape = (m: Record<string, unknown>, t: unknown) => canonicalJson({ manifest: { ...m, version: null }, tests: t });
      const sameCode = (v: { code_sha256: string; source_sha256: string | null }) => (source !== undefined ? v.source_sha256 === sha256Hex(source) : v.code_sha256 === sha256Hex(js!));
      await handle(where, { manifest: { ...manifest, version: null }, ...(source !== undefined ? { source } : { code }), tests }, {
        match: async () => (await versions()).find((v) => sameCode(v) && shape(v.manifest, v.tests) === shape(manifest, tests))?.version ?? null,
        order: cmpVersions,
        apply: async () => {
          const all = await versions();
          if (all.some((v) => v.status === 'draft' || v.status === 'pending_review')) {
            return held(`module ${name}: a version is already waiting for review; the change is read again once it is decided`);
          }
          // A higher version than any Dittoly has, whatever the file says.
          const latest = all.map((v) => v.version).sort(cmpVersions).at(-1);
          const asked = typeof manifest.version === 'string' ? manifest.version : '1.0.0';
          const version = !latest ? asked : cmpVersions(asked, latest) > 0 ? asked : bumpPatch(latest);
          const body = source !== undefined ? { source } : { code: js! };
          let mv;
          try {
            mv = await app.modules.createDraft({ manifest: { ...manifest, version }, ...body, tests, origin: 'git' }, null);
          } catch (err) {
            // The compiler's message names a line in module.ts: say which module's.
            if (err instanceof AppError && err.code === 'invalid_module_source') return problem(`${where}${err.message}`);
            throw err;
          }
          if (!mv.validationReport?.passed) return problem(`module ${name} ${version}: its sandbox tests failed; it stays a draft (Modules → ${name})`);
          await app.modules.submit(mv.id, null);
          return { created: { kind: 'module', name, version, id: mv.id } };
        },
      });
    }
  }

  // ---- Flows and Super Flows
  for (const [path, text] of snap.files) {
    const m = new RegExp(`^${escape(prefix)}flows/([^/]+)/([^/]+)/flow\\.json$`).exec(path);
    if (!m) continue;
    const file = parse(text);
    if (!isObject(file) || file.format !== 'dittoly-flow' || typeof file.name !== 'string' || !isObject(file.definition)) {
      await handle(path, text, { invalid: `${path}: not a Dittoly Flow file (format "dittoly-flow" with a name and a definition)` });
      continue;
    }
    const name = file.name;
    const teamId = teamFor(m[1]!);
    if (!teamId) {
      await handle(path, text, { invalid: `${path}: no team "${m[1]}" here without a repository of its own` });
      continue;
    }
    const definition = structuredClone(file.definition) as { steps?: { type?: string; runs?: { flow: string; version: number }[] }[] };
    // A Super Flow's Flows: by id on this server, else by the name and team the file gives.
    const children = Array.isArray(file.children) ? (file.children as { flowId?: string; name?: string; team?: string }[]) : [];
    let missing = '';
    for (const s of definition.steps ?? []) {
      for (const r of s.type === 'flow' ? (s.runs ?? []) : []) {
        if ((await db.query(`SELECT 1 FROM flows WHERE id = $1`, [r.flow])).rowCount) continue;
        const named = children.find((ch) => ch.flowId === r.flow);
        const found = named?.name
          ? (await db.query<{ id: string }>(`SELECT f.id FROM flows f JOIN teams t ON t.id = f.team_id WHERE f.name = $1 AND ($2::text IS NULL OR t.name = $2) AND f.archived_at IS NULL LIMIT 1`, [named.name, named.team ?? null])).rows[0]
          : undefined;
        if (found) r.flow = found.id;
        else missing = named?.name ?? r.flow;
      }
    }
    const existing = (await db.query<{ id: string }>(`SELECT id FROM flows WHERE team_id = $1 AND name = $2 AND archived_at IS NULL`, [teamId, name])).rows[0];
    await handle(path, { name, teamId, file: file.definition, children }, {
      match: async () => {
        if (missing || !existing) return null;
        const defs = (await db.query<{ version: number; definition: unknown }>(`SELECT version, definition FROM flow_versions WHERE flow_id = $1`, [existing.id])).rows;
        const same = defs.find((d) => canonicalJson(d.definition) === canonicalJson(definition));
        return same ? String(same.version) : null;
      },
      order: byNumber,
      apply: async () => {
        // A Flow it runs may come in a later read (or later in this one): read again until it is here.
        if (missing) return held(`${path}: runs the Flow "${missing}", which is not here; the file is read again`);
        try {
          const v = existing
            ? await app.flows.proposeFromGit(existing.id, definition, git(path))
            : await app.flows.create(name, definition, connector, { instructions: null, git: git(path) }, teamId);
          return { created: { kind: 'flow', name, version: v.version, id: v.id } };
        } catch (err) {
          if (err instanceof AppError && err.code === 'flow_change_pending') return held(`${path}: another change is waiting for approval; the file is read again once it is decided`);
          throw err;
        }
      },
    });
  }

  // ---- apps
  for (const [path, text] of snap.files) {
    const m = new RegExp(`^${escape(prefix)}apps/([^/]+)/([^/]+)/app\\.json$`).exec(path);
    if (!m) continue;
    const file = parse(text);
    if (!isObject(file) || file.format !== 'dittoly-app' || typeof file.name !== 'string' || !Array.isArray(file.flows)) {
      await handle(path, text, { invalid: `${path}: not a Dittoly app file (format "dittoly-app" with a name, flows and a plan)` });
      continue;
    }
    const name = file.name;
    const teamId = teamFor(m[1]!);
    if (!teamId) {
      await handle(path, text, { invalid: `${path}: no team "${m[1]}" here without a repository of its own` });
      continue;
    }
    const flows: { flowId: string }[] = [];
    for (const f of file.flows as { flowId?: string; name?: string }[]) {
      const byId = f.flowId ? (await db.query<{ id: string }>(`SELECT id FROM flows WHERE id = $1 AND team_id = $2`, [f.flowId, teamId])).rows[0] : undefined;
      const byName = byId ?? (f.name ? (await db.query<{ id: string }>(`SELECT id FROM flows WHERE name = $1 AND team_id = $2 AND archived_at IS NULL`, [f.name, teamId])).rows[0] : undefined);
      if (byName) flows.push({ flowId: byName.id });
    }
    const complete = flows.length === file.flows.length;
    const spec = { flows, plan: file.plan, ...(isObject(file.brand) ? { brand: file.brand } : {}) };
    const existing = (await db.query<{ id: string; created_by: string }>(`SELECT id, created_by FROM apps WHERE team_id = $1 AND name = $2 AND archived_at IS NULL`, [teamId, name])).rows[0];
    await handle(path, { name, teamId, file: { flows: file.flows, plan: file.plan, brand: file.brand ?? null } }, {
      match: async () => {
        if (!complete || !existing) return null;
        const specs = (await db.query<{ version: number; spec: unknown }>(`SELECT version, spec FROM app_versions WHERE app_id = $1`, [existing.id])).rows;
        const same = specs.find((s) => canonicalJson(s.spec) === canonicalJson(spec));
        return same ? String(same.version) : null;
      },
      order: byNumber,
      apply: async () => {
        // A new Flow it uses may come in a later read: read again until it is here.
        if (!complete) return held(`${path}: uses a Flow that is not in this team; the file is read again`);
        if (existing) {
          // Recorded as the app's author, like a change they would make; its live version stays live.
          const author = (await member(existing.created_by)) ?? connector;
          const r = await updateApp(app, author, existing.id, { name, spec });
          return { created: { kind: 'app', name, version: r.version, id: r.versionId } };
        }
        const r = await createApp(app, connector, { name, teamId, spec });
        return { created: { kind: 'app', name, version: r.version, id: r.versionId } };
      },
    });
  }

  // A held-back file that left the branch is no longer waited for. Deleting a file deletes nothing.
  for (const [key, s] of seen) if (s.waiting_sha && !present.has(key)) await db.query(`UPDATE git_import_files SET waiting_sha = NULL WHERE connection_id = $1 AND path = $2`, [c.id, key]);
  return out;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
