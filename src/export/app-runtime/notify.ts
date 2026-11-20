import { decisionLink, type AppEnv } from './env.js';
import type { Features, Notices } from './main.js';
import type { RunRecord, Store } from './store.js';

/**
 * Tell someone when a run waits for a person: a JSON POST to NOTIFY_WEBHOOK_URL (with signed
 * approve and reject links) and/or an email to NOTIFY_EMAIL. Each waiting step is announced once.
 * Nothing from the run's data is sent, only what it waits for. Only apps whose Flows wait for
 * people have this file.
 */
export class Notifier implements Notices {
  private mailer: Promise<{ sendMail(m: Record<string, unknown>): Promise<unknown> }> | null = null;

  constructor(
    private readonly env: AppEnv,
    private readonly app: { name: string; flowName: (key: string) => string; stepTitle: (flow: string, step: string) => string },
    private readonly store: Store,
    /** Records the notice on the run (through the engine, so it never overwrites a step). */
    private readonly markNotified: (runId: string, stepId: string) => Promise<void>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled() {
    return !!(this.env.notifyWebhookUrl || (this.env.notifyEmail && this.env.smtpUrl));
  }

  async waiting(runId: string, stepId: string): Promise<boolean> {
    if (!this.enabled) return false;
    const run = await this.store.getRun(runId);
    if (!run || run.notified.includes(stepId)) return false;
    const rec = run.steps.find((s) => s.id === stepId);
    if (rec?.status !== 'waiting') return false;
    const kind = run.waitReason === 'approval' ? 'approval' : 'input';
    const flow = this.app.flowName(run.flow);
    const event: Record<string, string> = {
      event: 'step.waiting',
      app: this.app.name,
      flow,
      runId,
      stepId,
      kind,
      title: this.app.stepTitle(run.flow, stepId),
      ...(kind === 'approval'
        ? { approveUrl: decisionLink(this.env, runId, stepId, 'approved'), rejectUrl: decisionLink(this.env, runId, stepId, 'rejected') }
        : { openUrl: `${this.env.publicUrl}/inbox` }),
    };
    if (this.env.notifyWebhookUrl) {
      const res = await this.fetchImpl(this.env.notifyWebhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`notify_http_${res.status}`);
    }
    if (this.env.notifyEmail && this.env.smtpUrl) {
      this.mailer ??= import('nodemailer').then((m) => m.default.createTransport(this.env.smtpUrl!));
      const lines = kind === 'approval' ? [`Approve: ${event.approveUrl!}`, `Reject: ${event.rejectUrl!}`] : [`Open: ${event.openUrl!}`];
      await (await this.mailer).sendMail({
        from: this.env.emailFrom,
        to: this.env.notifyEmail,
        subject: `${this.app.name}: ${flow} is waiting for ${kind === 'approval' ? 'approval' : 'an answer'}`,
        text: [`${flow} is waiting at "${event.title}".`, '', ...lines, '', 'The approve and reject links work for 7 days.'].join('\n'),
      });
    }
    // Recorded on the run, so a restart does not announce it again.
    await this.markNotified(runId, stepId);
    return true;
  }

  /** Steps that wait and were not announced yet (e.g. a notice that failed): tried again periodically. */
  async sweep(runs: RunRecord[]): Promise<void> {
    for (const r of runs) {
      if (r.status !== 'waiting' || (r.waitReason !== 'approval' && r.waitReason !== 'input_needed')) continue;
      for (const s of r.steps) if (s.status === 'waiting' && !r.notified.includes(s.id)) await this.waiting(r.id, s.id).catch(() => false);
    }
  }
}

export const notices: NonNullable<Features['notices']> = (...args) => new Notifier(...args);
