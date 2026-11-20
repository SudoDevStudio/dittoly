import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { App } from '../src/app.js';
import type { Member } from '../src/core/members.js';

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');

// The last five serve the "error to verified fix" template (test/fixtures/flows/error-to-fix.json).
const DEFAULT_EXAMPLES = ['jira', 'gitlab', 'slack', 'jira-triage', 'gitlab-notes', 'slack-files', 'datadog-logs', 'loki', 'gitlab-fix', 'github-fix', 'error-fix-policy', 'github-review'];

/**
 * Load the example Jira, GitLab and Slack modules (their reporting companions, and the error-to-fix modules) as drafts and submit them for
 * review. They stand in for chat-generated modules so Dittoly can be tried
 * without an AI backend. With `approveAs` (local install: the one member is the
 * admin) they are approved too. With `names`, only those folders of test/fixtures/modules (e.g.
 * loki-lan, node-errors and app-errors, which are not loaded by default).
 */
export async function loadExampleModules(app: App, actor: Member | null, approveAs?: Member, names: readonly string[] = DEFAULT_EXAMPLES): Promise<string[]> {
  const out: string[] = [];
  for (const name of names) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error(`not a fixture module name: ${name}`);
    const dir = path.join(FIXTURES, 'modules', name);
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
    const existing = await app.modules.findByRef(app.db, manifest.name, manifest.version);
    if (existing) {
      out.push(`${name}: already loaded (${existing.status})`);
      continue;
    }
    const mv = await app.modules.createDraft(
      {
        manifest,
        code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
        tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')),
        origin: 'seed',
      },
      actor,
    );
    await app.db.query(`UPDATE module_versions SET status = 'pending_review' WHERE id = $1 AND status = 'draft'`, [mv.id]);
    if (approveAs) await app.modules.decide(mv.id, approveAs, 'approved');
    out.push(`${name}: ${mv.validationReport?.passed ? 'validated' : 'FAILED validation'}, ${approveAs ? 'approved' : 'waiting for admin review'}`);
  }
  return out;
}
