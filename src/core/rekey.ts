import { Cipher } from './crypto.js';
import type { Db } from '../db/db.js';
import { withTx } from '../db/db.js';

/**
 * Every encrypted column, with the associated data its values are bound to.
 * Must list every `*_enc` column in the schema (a test checks this).
 */
interface EncryptedColumn {
  table: string;
  column: string;
  /** Columns that identify the row (and build the associated data). */
  keys: string[];
  aad: (row: Record<string, string>) => string;
}

export const ENCRYPTED_COLUMNS: EncryptedColumn[] = [
  { table: 'credentials', column: 'secret_enc', keys: ['member_id', 'service'], aad: (r) => `credential:${r.member_id}:${r.service}` },
  { table: 'triggers', column: 'secret_enc', keys: ['id'], aad: (r) => `trigger:${r.id}:secret` },
  { table: 'triggers', column: 'prev_secret_enc', keys: ['id'], aad: (r) => `trigger:${r.id}:prev` },
  { table: 'triggers', column: 'legacy_token_enc', keys: ['id'], aad: (r) => `trigger:${r.id}:legacy` },
  { table: 'runs', column: 'inputs_enc', keys: ['id'], aad: (r) => `run:${r.id}:inputs` },
  { table: 'run_steps', column: 'output_enc', keys: ['run_id', 'step_id'], aad: (r) => `run:${r.run_id}:step:${r.step_id}:output` },
  { table: 'run_steps', column: 'progress_enc', keys: ['run_id', 'step_id'], aad: (r) => `run:${r.run_id}:step:${r.step_id}:progress` },
  { table: 'run_steps', column: 'sign_off_enc', keys: ['run_id', 'step_id'], aad: (r) => `run:${r.run_id}:step:${r.step_id}:sign_off` },
  { table: 'run_steps', column: 'proposed_enc', keys: ['run_id', 'step_id'], aad: (r) => `run:${r.run_id}:step:${r.step_id}:proposed` },
  { table: 'run_steps', column: 'calls_enc', keys: ['run_id', 'step_id'], aad: (r) => `run:${r.run_id}:step:${r.step_id}:calls` },
  { table: 'run_steps', column: 'log_enc', keys: ['run_id', 'step_id'], aad: (r) => `run:${r.run_id}:step:${r.step_id}:log` },
  { table: 'run_steps', column: 'detail_enc', keys: ['run_id', 'step_id'], aad: (r) => `run:${r.run_id}:step:${r.step_id}:detail` },
  { table: 'artifact_journal', column: 'text_enc', keys: ['id'], aad: (r) => `artifact-journal:${r.id}:text` },
  { table: 'team_decisions', column: 'question_enc', keys: ['id'], aad: (r) => `team-decision:${r.id}:qa` },
  { table: 'team_decisions', column: 'answer_enc', keys: ['id'], aad: (r) => `team-decision:${r.id}:qa` },
  { table: 'ai_builds', column: 'title_enc', keys: ['id'], aad: (r) => `build:${r.id}:title` },
  { table: 'ai_builds', column: 'detail_enc', keys: ['id'], aad: (r) => `build:${r.id}:detail` },
  { table: 'run_commentary', column: 'text_enc', keys: ['id', 'run_id'], aad: (r) => `run:${r.run_id}:commentary` },
  { table: 'home_chats', column: 'messages_enc', keys: ['id'], aad: (r) => `home-chat:${r.id}:messages` },
  { table: 'home_chats', column: 'plan_enc', keys: ['id'], aad: (r) => `home-chat:${r.id}:plan` },
  { table: 'delegations', column: 'inputs_enc', keys: ['id'], aad: (r) => `delegation:${r.id}:inputs` },
  { table: 'schedules', column: 'inputs_enc', keys: ['id'], aad: (r) => `schedule:${r.id}:inputs` },
  { table: 'agent_calls', column: 'args_enc', keys: ['id'], aad: (r) => `agent-call:${r.id}:args` },
  { table: 'undo_records', column: 'input_enc', keys: ['id'], aad: (r) => `undo:${r.id}:input` },
  { table: 'flow_followups', column: 'inputs_enc', keys: ['id'], aad: (r) => `followup:${r.id}:inputs` },
  { table: 'oauth_clients', column: 'client_info_enc', keys: ['issuer'], aad: (r) => `oauth-client:${r.issuer}` },
  { table: 'team_credentials', column: 'secret_enc', keys: ['team_id', 'service'], aad: (r) => `team-credential:${r.team_id}:${r.service}` },
  { table: 'members', column: 'teams_webhook_enc', keys: ['id'], aad: (r) => `teams-webhook:${r.id}` },
  { table: 'device_actions', column: 'payload_enc', keys: ['id'], aad: (r) => `device-action:${r.id}` },
  { table: 'run_children', column: 'result_enc', keys: ['child_run_id'], aad: (r) => `run-child:${r.child_run_id}:result` },
  { table: 'plans', column: 'pdf_enc', keys: ['id'], aad: (r) => `plan:${r.id}:pdf` },
  { table: 'plans', column: 'text_enc', keys: ['id'], aad: (r) => `plan:${r.id}:text` },
  { table: 'plans', column: 'analysis_enc', keys: ['id'], aad: (r) => `plan:${r.id}:analysis` },
  { table: 'plans', column: 'answers_enc', keys: ['id'], aad: (r) => `plan:${r.id}:answers` },
  { table: 'plans', column: 'error_detail_enc', keys: ['id'], aad: (r) => `plan:${r.id}:error-detail` },
  { table: 'plans', column: 'error_raw_enc', keys: ['id'], aad: (r) => `plan:${r.id}:error-raw` },
  { table: 'plan_items', column: 'request_enc', keys: ['id'], aad: (r) => `plan-item:${r.id}:request` },
  { table: 'plan_items', column: 'detail_enc', keys: ['id'], aad: (r) => `plan-item:${r.id}:detail` },
  { table: 'plan_items', column: 'raw_enc', keys: ['id'], aad: (r) => `plan-item:${r.id}:raw` },
  { table: 'plan_items', column: 'questions_enc', keys: ['id'], aad: (r) => `plan-item:${r.id}:questions` },
  { table: 'plan_items', column: 'answers_enc', keys: ['id'], aad: (r) => `plan-item:${r.id}:answers` },
  { table: 'plan_items', column: 'notes_enc', keys: ['id'], aad: (r) => `plan-item:${r.id}:notes` },
  { table: 'plan_items', column: 'progress_detail_enc', keys: ['id'], aad: (r) => `plan-item:${r.id}:activity` },
  { table: 'watches', column: 'secret_enc', keys: ['id'], aad: (r) => `watch:${r.id}:secret` },
  { table: 'audit_anchors', column: 'secret_enc', keys: ['id'], aad: (r) => `audit-anchor:${r.id}` },
  { table: 'audit_streams', column: 'secret_enc', keys: ['id'], aad: (r) => `audit-stream:${r.id}` },
  { table: 'git_connections', column: 'token_enc', keys: ['id'], aad: (r) => `git-connection:${r.id}` },
  { table: 'oauth_pending', column: 'verifier_enc', keys: ['state', 'member_id'], aad: (r) => `oauth-pending:${r.member_id}` },
  { table: 'data_rows', column: 'key_enc', keys: ['id'], aad: (r) => `data-row:${r.id}:key` },
  { table: 'data_rows', column: 'values_enc', keys: ['id'], aad: (r) => `data-row:${r.id}:values` },
  { table: 'flow_tests', column: 'case_enc', keys: ['id'], aad: (r) => `flow-test:${r.id}:case` },
  { table: 'model_change_checks', column: 'details_enc', keys: ['id'], aad: (r) => `model-check:${r.id}:details` },
];

/**
 * Re-encrypt every stored secret with a new master key, in one transaction:
 * either everything moves to the new key or nothing changes. Fails (and
 * changes nothing) if any value does not decrypt with the old key.
 *
 * Run it with every server process stopped. Values that only live in transit
 * are not re-encrypted: queued webhook deliveries and sign-ins in progress
 * fail and have to be sent again.
 */
export async function rotateMasterKey(db: Db, oldKey: Buffer, newKey: Buffer): Promise<{ values: number }> {
  if (oldKey.equals(newKey)) throw new Error('the new key is the same as the old key');
  const from = new Cipher(oldKey);
  const to = new Cipher(newKey);
  let values = 0;
  await withTx(db, async (tx) => {
    for (const c of ENCRYPTED_COLUMNS) {
      const cols = c.keys.map((k) => `"${k}"`).join(', ');
      const { rows } = await tx.query<Record<string, string>>(
        `SELECT ${cols}, "${c.column}" AS v FROM "${c.table}" WHERE "${c.column}" IS NOT NULL FOR UPDATE`,
      );
      for (const row of rows) {
        const aad = c.aad(row);
        let plain: string;
        try {
          plain = from.decrypt(row.v!, aad);
        } catch {
          throw new Error(`a value in ${c.table}.${c.column} does not decrypt with the current key; nothing was changed`);
        }
        const where = c.keys.map((k, i) => `"${k}" = $${i + 2}`).join(' AND ');
        await tx.query(`UPDATE "${c.table}" SET "${c.column}" = $1 WHERE ${where}`, [to.encrypt(plain, aad), ...c.keys.map((k) => row[k])]);
        values++;
      }
    }
    // Data table rows are found by a keyed hash, which changes with the key.
    const rows = await tx.query<{ id: string; table_id: string; key_enc: string }>(`SELECT id, table_id, key_enc FROM data_rows FOR UPDATE`);
    for (const r of rows.rows) {
      const key = to.decrypt(r.key_enc, `data-row:${r.id}:key`);
      await tx.query(`UPDATE data_rows SET key_hash = $2 WHERE id = $1`, [r.id, to.lookupHash(`${r.table_id}:${key}`)]);
    }
  });
  return { values };
}

/** Whether `key` decrypts the stored values (checks the first value found). Null when nothing is encrypted yet. */
export async function keyMatches(db: Db, key: Buffer): Promise<boolean | null> {
  const cipher = new Cipher(key);
  for (const c of ENCRYPTED_COLUMNS) {
    const cols = c.keys.map((k) => `"${k}"`).join(', ');
    const row = (await db.query<Record<string, string>>(`SELECT ${cols}, "${c.column}" AS v FROM "${c.table}" WHERE "${c.column}" IS NOT NULL LIMIT 1`)).rows[0];
    if (!row) continue;
    try {
      cipher.decrypt(row.v!, c.aad(row));
      return true;
    } catch {
      return false;
    }
  }
  return null;
}
