import { interpretCommand, type Command, type CommandContext } from '../ai/command.js';
import { AiError, type AiProvider } from '../ai/provider.js';
import { audit } from '../core/audit.js';
import type { Cipher } from '../core/crypto.js';
import { AppError } from '../core/errors.js';
import type { Member } from '../core/members.js';
import type { Db } from '../db/db.js';
import type { Engine } from '../engine/engine.js';
import type { FlowService } from '../flows/service.js';
import { ajv } from '../modules/manifest.js';
import { takeToken } from '../webhooks/service.js';

/** A confirmed action must be confirmed this soon. */
const CONFIRM_SECONDS = 120;
const COMMANDS_PER_MINUTE = 30;

type Pending =
  | { kind: 'run'; versionId: string; inputs: Record<string, unknown> }
  | { kind: 'gate'; runId: string; stepId: string; decision: 'approved' | 'rejected' }
  | { kind: 'input'; runId: string; stepId: string; values: Record<string, unknown> }
  | { kind: 'delegation'; delegationId: string; decision: 'approved' | 'rejected' };

/** What the phone shows and speaks. `confirm` is set when the person must say yes first. */
export interface Reply {
  say: string;
  confirm?: { id: string; summary: string };
  /** A run this reply started or is about, for the phone to follow. */
  runId?: string;
}

interface Sources {
  runnable: (member: Member) => Promise<{ versionId: string; name: string; version: number; description: string | null; blocked: string | null }[]>;
  approvals: (member: Member) => Promise<{ kind: string; title: string; runId?: string | undefined; stepId?: string | undefined }[]>;
}

const aad = (id: string) => `device-action:${id}`;
const STATUS: Record<string, string> = {
  running: 'is running',
  waiting: 'is waiting',
  paused: 'is paused',
  succeeded: 'finished successfully',
  failed: 'failed',
  cancelled: 'was cancelled',
};
const WAIT: Record<string, string> = {
  approval: 'for a sign-off',
  input_needed: 'for you to fill in a form',
  delay: 'for a timer',
  child_flows: 'for the Flows it started',
  delegation: 'for a teammate',
};

/**
 * Commands from a paired phone or glasses: "run release notes for 2.4", "how did it
 * go?", "approve it". The organization's AI proposes one action from the things
 * this person may do; the server checks it, and anything that changes something
 * waits for the person's yes. Everything runs as the person, with their own access.
 */
export class DeviceCommands {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher,
    private readonly ai: AiProvider | null,
    private readonly engine: Engine,
    private readonly flows: FlowService,
    private readonly sources: Sources,
  ) {}

  async command(member: Member, deviceId: string, text: string, history: { role: 'person' | 'dittoly'; text: string }[] = []): Promise<Reply> {
    if (!(await takeToken(this.db, `device:${deviceId}`, COMMANDS_PER_MINUTE))) throw new AppError('rate_limited', 429);
    if (!this.ai) throw new AppError('ai_provider_not_configured', 503);
    // A new command replaces anything still waiting for a yes.
    await this.db.query(`UPDATE device_actions SET used_at = now() WHERE device_id = $1 AND used_at IS NULL`, [deviceId]);
    const context = await this.context(member);
    let cmd: Command;
    try {
      cmd = await interpretCommand(this.ai, text.slice(0, 2000), context, history);
    } catch (err) {
      if (err instanceof AiError) return { say: 'Sorry, I could not understand that. Please try again.' };
      throw err;
    }
    switch (cmd.action) {
      case 'run_flow':
        return this.proposeRun(deviceId, cmd, context);
      case 'status':
        return this.status(member, cmd.runId ?? context.runs[0]?.runId);
      case 'inbox':
        return { say: this.inboxText(context) };
      case 'decide_gate': {
        const gate = context.gates.find((g) => g.runId === cmd.runId && g.stepId === cmd.stepId);
        if (!gate || !cmd.decision) return { say: cmd.say || 'Which sign-off do you mean?' };
        return this.propose(deviceId, { kind: 'gate', runId: gate.runId, stepId: gate.stepId, decision: cmd.decision }, `${cmd.decision === 'approved' ? 'Approve' : 'Reject'} the sign-off "${gate.title}".`, gate.runId);
      }
      case 'decide_delegation': {
        const d = context.delegations.find((x) => x.id === cmd.delegationId);
        if (!d || !cmd.decision) return { say: cmd.say || 'Which request do you mean?' };
        return this.propose(deviceId, { kind: 'delegation', delegationId: d.id, decision: cmd.decision }, `${cmd.decision === 'approved' ? 'Run' : 'Decline'} "${d.action}" for ${d.from} with your account.`);
      }
      case 'answer_input': {
        const form = context.inputs.find((i) => i.runId === cmd.runId && i.stepId === cmd.stepId);
        if (!form || !cmd.values || !Object.keys(cmd.values).length) return { say: cmd.say || 'Which form, and what should I fill in?' };
        const known = Object.fromEntries(Object.entries(cmd.values).filter(([k]) => form.fields.some((f) => f.name === k)));
        const text = Object.entries(known).map(([k, v]) => `${form.fields.find((f) => f.name === k)!.label}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('; ');
        return this.propose(deviceId, { kind: 'input', runId: form.runId, stepId: form.stepId, values: known }, `Answer "${form.title}" with ${text}.`, form.runId);
      }
      default:
        return { say: cmd.say || 'How can I help? You can say, for example, "run" and a Flow name, or "what is waiting for me".' };
    }
  }

  /** The person said yes (or no) to what was proposed. */
  async confirm(member: Member, deviceId: string, actionId: string, yes: boolean): Promise<Reply> {
    const { rows } = await this.db.query<{ id: string; kind: string; payload_enc: string; summary: string }>(
      `UPDATE device_actions SET used_at = now() WHERE id = $1 AND device_id = $2 AND used_at IS NULL AND expires_at > now() RETURNING id, kind, payload_enc, summary`,
      [actionId, deviceId],
    );
    const row = rows[0];
    if (!row) return { say: 'That has expired. Please say it again.' };
    if (!yes) return { say: 'OK, cancelled. Nothing was changed.' };
    const p = this.cipher.decryptJson<Pending>(row.payload_enc, aad(row.id));
    await audit(this.db, { actorId: member.id, action: `device.${p.kind}`, subjectType: 'device', subjectId: deviceId, outcome: 'ok' });
    try {
      if (p.kind === 'run') {
        const runId = await this.engine.startRun(p.versionId, member.id, p.inputs, { actorId: member.id });
        return { say: "Started. I'll tell you when it finishes.", runId };
      }
      if (p.kind === 'gate') {
        await this.engine.decideGate(p.runId, p.stepId, member, p.decision);
        return { say: p.decision === 'approved' ? 'Approved. The run continues.' : 'Rejected. The run stops.', runId: p.runId };
      }
      if (p.kind === 'input') {
        await this.engine.submitInput(p.runId, p.stepId, member, p.values);
        return { say: 'Sent. The run continues.', runId: p.runId };
      }
      await this.engine.decideDelegation(p.delegationId, member, p.decision);
      return { say: p.decision === 'approved' ? 'Done. The action ran with your account.' : 'Declined.' };
    } catch (err) {
      if (err instanceof AppError) return { say: `That did not work: ${err.message.replace(/_/g, ' ')}.` };
      throw err;
    }
  }

  /** A run's status, as a sentence (what the phone speaks when a run it follows changes). */
  async status(member: Member, runId: string | undefined): Promise<Reply> {
    if (!runId) return { say: 'You have no runs yet.' };
    let run;
    try {
      run = await this.engine.runView(runId, member);
    } catch (err) {
      if (err instanceof AppError) return { say: 'I could not find that run.' };
      throw err;
    }
    let say = `${run.flowName} ${STATUS[run.status] ?? run.status}`;
    if (run.status === 'waiting' && run.waitReason) say += ` ${WAIT[run.waitReason] ?? ''}`.trimEnd();
    const failed = run.steps.find((s) => s.status === 'failed');
    if (failed && (run.status === 'paused' || run.status === 'failed')) say += ` at "${failed.title ?? failed.id}"${failed.errorType ? `: ${failed.errorType.replace(/_/g, ' ')}` : ''}`;
    return { say: `${say}.`, runId };
  }

  async inbox(member: Member): Promise<Reply & { items: { kind: string; title: string; runId?: string }[] }> {
    const c = await this.context(member);
    return {
      say: this.inboxText(c),
      items: [
        ...c.gates.map((g) => ({ kind: 'sign-off', title: g.title, runId: g.runId })),
        ...c.inputs.map((i) => ({ kind: 'form', title: i.title, runId: i.runId })),
        ...c.delegations.map((d) => ({ kind: 'request', title: `${d.action} for ${d.from}` })),
      ],
    };
  }

  // ------------------------------------------------------------------ helpers

  private async proposeRun(deviceId: string, cmd: Command, context: CommandContext): Promise<Reply> {
    const flow = context.flows.find((f) => f.versionId === cmd.versionId);
    if (!flow) return { say: cmd.say || 'Which Flow should I run?' };
    const inputs = cmd.inputs ?? {};
    const schema = flow.inputs as { properties?: Record<string, { title?: string; description?: string }>; required?: string[] };
    const missing = (schema.required ?? []).filter((k) => inputs[k] === undefined || inputs[k] === '');
    if (missing.length) return { say: `To run ${flow.name} I need ${missing.map((k) => schema.properties?.[k]?.title ?? k.replace(/_/g, ' ')).join(' and ')}.` };
    const problems = ajv.explain(flow.inputs, inputs);
    if (problems.length) return { say: `Some values do not fit ${flow.name}: ${problems.slice(0, 2).join('; ')}.` };
    const given = Object.entries(inputs).map(([k, v]) => `${k.replace(/_/g, ' ')} ${Array.isArray(v) ? v.join(', ') : String(v)}`).join(', ');
    return this.propose(deviceId, { kind: 'run', versionId: flow.versionId, inputs }, `Run ${flow.name}${given ? ` with ${given}` : ''}.`);
  }

  private async propose(deviceId: string, payload: Pending, summary: string, runId?: string): Promise<Reply> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO device_actions (device_id, kind, payload_enc, summary, expires_at) VALUES ($1, $2, '', $3, $4) RETURNING id`,
      [deviceId, payload.kind, summary, new Date(Date.now() + CONFIRM_SECONDS * 1000)],
    );
    const id = rows[0]!.id;
    await this.db.query(`UPDATE device_actions SET payload_enc = $2 WHERE id = $1`, [id, this.cipher.encryptJson(payload, aad(id))]);
    return { say: `${summary} Say yes to go ahead, or no.`, confirm: { id, summary }, ...(runId ? { runId } : {}) };
  }

  private inboxText(c: CommandContext): string {
    const parts = [
      c.gates.length ? `${c.gates.length} sign-off${c.gates.length > 1 ? 's' : ''}: ${c.gates.map((g) => g.title).join('; ')}` : '',
      c.inputs.length ? `${c.inputs.length} form${c.inputs.length > 1 ? 's' : ''} to fill in: ${c.inputs.map((i) => i.title).join('; ')}` : '',
      c.delegations.length ? `${c.delegations.length} teammate request${c.delegations.length > 1 ? 's' : ''}: ${c.delegations.map((d) => `${d.action} for ${d.from}`).join('; ')}` : '',
    ].filter(Boolean);
    return parts.length ? `Waiting for you: ${parts.join('. ')}.` : 'Nothing is waiting for you.';
  }

  /** Everything the person may act on right now: the only ids a command can use. */
  private async context(member: Member): Promise<CommandContext> {
    const runnable = (await this.sources.runnable(member)).filter((r) => !r.blocked).slice(0, 60);
    const flows = await Promise.all(
      runnable.map(async (r) => ({
        versionId: r.versionId,
        name: r.name,
        version: r.version,
        description: r.description ?? '',
        inputs: (await this.flows.getVersion(this.db, r.versionId))?.definition.inputs ?? {},
      })),
    );
    const runs = (
      await this.db.query<{ id: string; status: string; wait_reason: string | null; created_at: Date; name: string }>(
        `SELECT r.id, r.status, r.wait_reason, r.created_at, f.name FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id JOIN flows f ON f.id = v.flow_id
         WHERE r.run_as = $1 ORDER BY r.created_at DESC LIMIT 10`,
        [member.id],
      )
    ).rows.map((r) => ({ runId: r.id, flow: r.name, status: r.status, waitReason: r.wait_reason, startedAt: r.created_at.toISOString() }));
    const approvals = await this.sources.approvals(member);
    const gates = approvals.filter((a) => a.kind === 'gate' && a.runId && a.stepId).map((a) => ({ runId: a.runId!, stepId: a.stepId!, title: a.title }));
    const inputs = [];
    for (const a of approvals.filter((x) => x.kind === 'input' && x.runId && x.stepId).slice(0, 10)) {
      const view = await this.engine.runView(a.runId!, member);
      const step = view.steps.find((s) => s.id === a.stepId);
      if (!step?.input) continue;
      inputs.push({
        runId: a.runId!,
        stepId: a.stepId!,
        title: a.title,
        fields: step.input.fields.map((f) => ({ name: f.name, label: f.label, widget: f.widget, options: f.choices?.map((c) => String(c.value)).slice(0, 20) })),
      });
    }
    const delegations = (
      await this.db.query<{ id: string; action: string; handle: string }>(
        `SELECT d.id, d.action, m.handle FROM delegations d JOIN members m ON m.id = d.requester_id
         WHERE d.delegate_id = $1 AND d.status = 'pending' AND d.expires_at > now() ORDER BY d.created_at`,
        [member.id],
      )
    ).rows.map((d) => ({ id: d.id, action: d.action, from: d.handle }));
    return { flows, runs, gates, inputs, delegations };
  }
}
