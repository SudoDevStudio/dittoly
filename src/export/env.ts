import type { EnvKind, EnvVar } from './app-runtime/env.js';

export type { EnvKind, EnvVar } from './app-runtime/env.js';

/**
 * Environment variables of an exported app. Every value an organization set in Dittoly
 * (module settings, credentials, the AI key, webhook secrets) becomes a variable, so the app
 * is configured the way containers are: an env file, Docker or Kubernetes secrets. Any
 * variable can also be given as <NAME>_FILE, the path of a file holding the value.
 */

const upper = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
export const settingEnv = (module: string, setting: string) => `SETTING_${upper(module)}_${upper(setting)}`;
export const credentialEnv = (service: string) => `CRED_${upper(service)}`;
export const hookEnv = (flowKey: string) => `HOOK_SECRET_${upper(flowKey)}`;

/** The variables every exported app has, before the ones its modules and Flows need. */
export function appEnv(o: { tokenFlows: boolean; humanSteps: boolean; hasApi: boolean; state: boolean }): EnvVar[] {
  const vars: EnvVar[] = [
    { name: 'APP_SECRET', kind: 'app', required: true, secret: true, description: 'At least 32 random characters. Encrypts stored data and signs links; keep it the same across restarts (openssl rand -base64 48).' },
    { name: 'APP_API_TOKEN', kind: 'app', required: o.hasApi && o.tokenFlows, secret: true, description: 'Bearer token for starting runs of non-public Flows and reading runs (Authorization: Bearer <token>).' },
    { name: 'APP_ADMIN_TOKEN', kind: 'app', required: o.humanSteps, secret: true, description: 'Bearer token for approvals, forms the Flows wait on, and the runs list in the app.' },
    { name: 'PUBLIC_URL', kind: 'app', required: false, secret: false, description: 'The address people open the app at; used in approval links.', example: 'http://localhost:8080' },
    { name: 'PORT', kind: 'app', required: false, secret: false, description: 'Port to listen on.', example: '8080' },
    // Only apps whose runs must outlive a restart have a store; the others keep runs in memory.
    ...(o.state
      ? [{ name: 'STATE_URL', kind: 'app' as const, required: true, secret: true, description: 'Where runs that wait (sign-offs, forms, delays) and table rows are kept, so they outlive a restart: redis://... or postgres://...', example: 'redis://state:6379' }]
      : []),
    { name: 'RUN_RETENTION_DAYS', kind: 'app', required: false, secret: false, description: 'Days finished runs are kept (0 = their inputs and outputs are deleted when they end).', example: '30' },
    { name: 'SANDBOX_WORKERS', kind: 'app', required: false, secret: false, description: 'Warm sandbox workers per module: how many calls of one module run at the same time.', example: '2' },
    { name: 'INTERNAL_HOSTS', kind: 'app', required: false, secret: false, description: 'Comma-separated host[:port] allowed to resolve to private network addresses (self-hosted systems).' },
    { name: 'CORS_ORIGINS', kind: 'app', required: false, secret: false, description: 'Comma-separated origins allowed to call the API from a browser when the frontend is hosted elsewhere.' },
    { name: 'NOTIFY_WEBHOOK_URL', kind: 'notify', required: false, secret: true, description: 'Receives a JSON POST when a run waits for a person, with signed approve and reject links.' },
    { name: 'NOTIFY_EMAIL', kind: 'notify', required: false, secret: false, description: 'Address to email when a run waits for a person (needs SMTP_URL).' },
    { name: 'SMTP_URL', kind: 'notify', required: false, secret: true, description: 'smtp(s)://user:password@host:port for notification email.' },
    { name: 'EMAIL_FROM', kind: 'notify', required: false, secret: false, description: 'Sender of notification email.', example: 'app@example.com' },
  ];
  // Notices are only for Flows that wait for a person.
  return o.humanSteps ? vars : vars.filter((v) => v.kind !== 'notify');
}

/** The .env.example file: required first, secrets left blank, examples filled in. */
export function envExample(vars: EnvVar[], appName: string): string {
  const lines = [`# ${appName}: environment for the exported app. Any variable can also be set as <NAME>_FILE (a file holding the value).`, ''];
  const groups: [EnvKind[], string][] = [
    [['app'], 'App'],
    [['setting'], 'What the Flows tell the modules'],
    [['credential'], 'Credentials (every run uses these)'],
    [['ai'], 'AI (your own key)'],
    [['hook'], 'Webhook secrets'],
    [['notify'], 'Notifications for steps that wait for a person'],
  ];
  for (const [kinds, title] of groups) {
    const list = vars.filter((v) => kinds.includes(v.kind));
    if (!list.length) continue;
    lines.push(`# --- ${title} ---`);
    for (const v of list) {
      lines.push(`# ${v.required ? 'REQUIRED. ' : ''}${v.description}`);
      // Secrets stay blank; an example a secret has (the bundled Redis' address) is not secret.
      lines.push(`${v.required ? '' : '# '}${v.name}=${v.example ?? ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
