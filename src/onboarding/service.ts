import type { App } from '../app.js';
import type { Member } from '../core/members.js';

/**
 * The "Get started" checklist: the first things a new organization does, each ticked off
 * from what has really happened (nothing is ticked by hand), in the order of
 * docs/getting-started.md.
 */
export interface OnboardingStep {
  id: 'ai' | 'module' | 'credentials' | 'flow' | 'run' | 'team' | 'export';
  title: string;
  detail: string;
  done: boolean;
  optional: boolean;
  /** Where in the portal to do it; null when it is done outside the portal (the AI key is set where Dittoly runs). */
  link: string | null;
}

export interface Onboarding {
  steps: OnboardingStep[];
  /** Every required step is done. */
  complete: boolean;
  hidden: boolean;
}

export async function onboarding(app: App, actor: Member): Promise<Onboarding> {
  const admin = actor.role === 'admin';
  const exporter = admin || actor.role === 'approver';
  const r = (
    await app.db.query<{ module: boolean; credentials: boolean; flow: boolean; run: boolean; members: number; exported: boolean; hidden: boolean }>(
      `SELECT
         EXISTS (SELECT 1 FROM module_versions WHERE status = 'approved') AS module,
         EXISTS (SELECT 1 FROM credentials WHERE member_id = $1)
           OR EXISTS (SELECT 1 FROM team_credentials c JOIN team_members t ON t.team_id = c.team_id WHERE t.member_id = $1) AS credentials,
         EXISTS (SELECT 1 FROM flow_versions WHERE status = 'approved') AS flow,
         EXISTS (SELECT 1 FROM runs WHERE run_as = $1 AND status = 'succeeded' AND NOT dry) AS run,
         (SELECT count(*)::int FROM members) AS members,
         EXISTS (SELECT 1 FROM app_exports) AS exported,
         (SELECT onboarding_hidden_at IS NOT NULL FROM members WHERE id = $1) AS hidden`,
      [actor.id],
    )
  ).rows[0]!;
  const steps: OnboardingStep[] = [
    {
      id: 'ai',
      title: 'Connect your AI',
      detail: admin
        ? 'Set DITTOLY_AI_PROVIDER and your own key where Dittoly runs. Without it you still build Flows by hand.'
        : 'An admin sets the organization’s own AI key. Without it you still build Flows by hand.',
      done: app.ai !== null,
      optional: true,
      link: null,
    },
    {
      id: 'module',
      title: 'Approve a module',
      detail: admin ? 'A module is how Dittoly talks to one app. Draft one with the AI, or approve one from the marketplace.' : 'A module is how Dittoly talks to one app. Ask for one; an admin reviews and approves it.',
      done: r.module,
      optional: false,
      link: '/modules',
    },
    {
      id: 'credentials',
      title: 'Store your credentials',
      detail: 'Your own token for each app, encrypted. Runs you start use your access, nobody else’s.',
      done: r.credentials,
      optional: false,
      link: '/credentials',
    },
    {
      id: 'flow',
      title: 'Create and approve a Flow',
      detail: 'Describe what should happen, or drag steps onto the canvas. An approver reads it in plain words and approves it.',
      done: r.flow,
      optional: false,
      link: '/flows',
    },
    {
      id: 'run',
      title: 'Run a Flow',
      detail: 'Fill in its form and run it. Try a dry run first: it reads for real and changes nothing.',
      done: r.run,
      optional: false,
      link: '/run',
    },
  ];
  if (admin && app.config.mode === 'shared') {
    steps.push({ id: 'team', title: 'Invite your team', detail: 'People sign in with your single sign-on and appear here. Give each a role: members build and run Flows, approvers approve them, admins also review modules.', done: r.members > 1, optional: false, link: '/admin' });
  }
  if (exporter) {
    steps.push({ id: 'export', title: 'Export a Flow as an app', detail: 'Package approved Flows as a Docker image that runs on its own, set up with environment variables.', done: r.exported, optional: true, link: '/apps' });
  }
  return { steps, complete: steps.every((s) => s.done || s.optional), hidden: r.hidden };
}

export async function setOnboardingHidden(app: App, actor: Member, hidden: boolean): Promise<void> {
  await app.db.query(`UPDATE members SET onboarding_hidden_at = ${hidden ? 'now()' : 'NULL'} WHERE id = $1`, [actor.id]);
}
