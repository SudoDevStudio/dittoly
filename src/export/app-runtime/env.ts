import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type EnvKind = 'app' | 'setting' | 'credential' | 'ai' | 'hook' | 'notify';

export interface EnvVar {
  name: string;
  kind: EnvKind;
  required: boolean;
  /** Hidden in logs and never written to the bundle. */
  secret: boolean;
  description: string;
  /** A non-secret value to start from (e.g. the organization's own setting). */
  example?: string | undefined;
  module?: string | undefined;
  setting?: string | undefined;
  service?: string | undefined;
  flow?: string | undefined;
}

/** Read a variable, or the file named by <NAME>_FILE. Values are trimmed of one trailing newline (files usually end with one). */
export function readEnv(env: NodeJS.ProcessEnv, name: string, readFile: (p: string) => string): string | undefined {
  const direct = env[name];
  if (direct !== undefined && direct !== '') return direct;
  const file = env[`${name}_FILE`];
  if (file) return readFile(file).replace(/\r?\n$/, '');
  return undefined;
}

/** The app's settings, all from the environment (every name is listed in .env.example). */
export interface AppEnv {
  secret: string;
  apiToken: string | null;
  adminToken: string | null;
  port: number;
  publicUrl: string;
  /** Where runs and table rows are kept: redis:// or postgres://. Required when a Flow waits or uses a table. */
  stateUrl: string | null;
  retentionDays: number;
  internalHosts: string[];
  insecureHttpHosts: string[];
  corsOrigins: string[];
  notifyWebhookUrl: string | null;
  notifyEmail: string | null;
  smtpUrl: string | null;
  emailFrom: string;
  ai: { provider: 'anthropic' | 'openai' | 'ollama' | 'none'; apiKey: string | null; model: string | null; ollamaUrl: string | null };
  /** Module settings by module name; credentials by service; webhook secrets by Flow key. */
  settings: Record<string, Record<string, string>>;
  credentials: Record<string, string>;
  hookSecrets: Record<string, string>;
  disableSchedules: boolean;
  /** Warm sandbox workers per module. */
  workers: number;
}

export class ConfigError extends Error {}

const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

/** Read and check the environment. Messages name variables, never values. */
export function readAppEnv(
  env: NodeJS.ProcessEnv,
  app: { slug: string; env: EnvVar[]; needsState: boolean },
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): AppEnv {
  const get = (name: string) => readEnv(env, name, readFile);
  const problems: string[] = [];
  for (const v of app.env) if (v.required && !get(v.name)) problems.push(`${v.name} is required: ${v.description}`);
  const secret = get('APP_SECRET') ?? '';
  if (secret && secret.length < 32) problems.push('APP_SECRET must be at least 32 characters');
  const port = Number(get('PORT') ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT must be a port number');
  const retention = get('RUN_RETENTION_DAYS');
  if (retention !== undefined && !/^\d{1,4}$/.test(retention)) problems.push('RUN_RETENTION_DAYS must be a number of days');
  const stateUrl = get('STATE_URL') ?? null;
  if (app.needsState && !stateUrl && !app.env.some((v) => v.name === 'STATE_URL' && v.required)) problems.push('STATE_URL is required: some Flows wait for a person, wait a while or use a table, so runs must outlive a restart (redis://... or postgres://...)');
  if (stateUrl && !/^(rediss?|postgres(ql)?):\/\//i.test(stateUrl)) problems.push('STATE_URL must start with redis://, rediss://, postgres:// or postgresql://');
  const providerRaw = (get('AI_PROVIDER') ?? 'none').toLowerCase();
  if (!['anthropic', 'openai', 'ollama', 'none'].includes(providerRaw)) problems.push('AI_PROVIDER must be anthropic, openai or ollama');
  const provider = providerRaw as AppEnv['ai']['provider'];
  if ((provider === 'anthropic' || provider === 'openai') && !get('AI_API_KEY')) problems.push(`AI_API_KEY is required for AI_PROVIDER=${provider}`);
  if (provider === 'ollama' && !get('AI_MODEL')) problems.push('AI_MODEL is required for AI_PROVIDER=ollama');
  if (get('NOTIFY_EMAIL') && !get('SMTP_URL')) problems.push('NOTIFY_EMAIL needs SMTP_URL');
  const publicUrl = (get('PUBLIC_URL') ?? `http://localhost:${port}`).replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/.test(publicUrl)) problems.push('PUBLIC_URL must be an http(s) address');
  const workers = Number(get('SANDBOX_WORKERS') ?? 2);
  if (!Number.isInteger(workers) || workers < 1 || workers > 32) problems.push('SANDBOX_WORKERS must be 1 to 32');
  if (problems.length) throw new ConfigError(`The app is not configured:\n- ${problems.join('\n- ')}`);

  const settings: AppEnv['settings'] = {};
  const credentials: AppEnv['credentials'] = {};
  const hookSecrets: AppEnv['hookSecrets'] = {};
  for (const v of app.env) {
    const value = get(v.name);
    if (value === undefined) continue;
    if (v.kind === 'setting' && v.module && v.setting) (settings[v.module] ??= {})[v.setting] = value;
    if (v.kind === 'credential' && v.service) credentials[v.service] = value;
    if (v.kind === 'hook' && v.flow) hookSecrets[v.flow] = value;
  }
  return {
    secret,
    apiToken: get('APP_API_TOKEN') ?? null,
    adminToken: get('APP_ADMIN_TOKEN') ?? null,
    port,
    publicUrl,
    stateUrl,
    retentionDays: retention === undefined ? 30 : Number(retention),
    internalHosts: list(get('INTERNAL_HOSTS')),
    insecureHttpHosts: list(get('INSECURE_HTTP_HOSTS')),
    corsOrigins: list(get('CORS_ORIGINS')),
    notifyWebhookUrl: get('NOTIFY_WEBHOOK_URL') ?? null,
    notifyEmail: get('NOTIFY_EMAIL') ?? null,
    smtpUrl: get('SMTP_URL') ?? null,
    emailFrom: get('EMAIL_FROM') ?? `${app.slug}@localhost`,
    ai: { provider, apiKey: get('AI_API_KEY') ?? null, model: get('AI_MODEL') ?? null, ollamaUrl: get('OLLAMA_URL') ?? null },
    settings,
    credentials,
    hookSecrets,
    disableSchedules: /^(1|true|yes)$/i.test(get('DISABLE_SCHEDULES') ?? ''),
    workers,
  };
}

/** Keys derived from APP_SECRET: link signing and run tokens never share bytes. */
export function deriveKey(secret: string, purpose: 'links' | 'run-tokens'): Buffer {
  // The key-derivation salt never changes: links and tokens already issued were signed with it.
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('6d6f64756c6f6f6d2d617070', 'hex'), Buffer.from(purpose), 32));
}
export const sign = (key: Buffer, text: string) => createHmac('sha256', key).update(text).digest('base64url');
export const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A signed approve or reject link for a notification (valid 7 days). */
export function decisionLink(env: AppEnv, runId: string, stepId: string, decision: 'approved' | 'rejected'): string {
  const exp = Math.floor(Date.now() / 1000) + 7 * 86_400;
  const sig = sign(deriveKey(env.secret, 'links'), `${runId}.${stepId}.${decision}.${exp}`);
  return `${env.publicUrl}/approve?${new URLSearchParams({ run: runId, step: stepId, decision, exp: String(exp), sig })}`;
}
