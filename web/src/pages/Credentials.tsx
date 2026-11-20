import { useEffect, useState } from 'react';
import { api } from '../api';
import { Card, Empty, ErrorText, Loading, Page, useAction, useLoad, When } from '../components';

import { Icon, Notice } from '../ui';
import { WebhookHub } from './WebhookHub';
import { DevicesCard } from '../Devices';
import { StandinsCard } from '../Standins';
import { McpTokensCard } from '../Mcp';
import { BreakglassCard, ReviewsCard, ScopeBadge, type ScopeCheck } from '../Governance';

interface Cred { service: string; updatedAt: string; reviewDueAt: string; scopeCheck: ScopeCheck | null }
interface Connection { service: string; serverUrl: string }
interface Needed { service: string; label: string; placement: string; modules: string[]; optional: boolean; stored: boolean }
interface Settings {
  email: string | null;
  emailNotifications: boolean;
  emailConfigured: boolean;
  slackNotifications: boolean;
  slackConfigured: boolean;
  teamsNotifications: boolean;
  teamsConfigured: boolean;
  teamsPersonal: boolean;
  teamChannelNotifications: boolean;
}
type Channel = 'emailNotifications' | 'slackNotifications' | 'teamsNotifications' | 'teamChannelNotifications';

export function Credentials() {
  const list = useLoad(() => api<Cred[]>('/me/credentials'));
  const settings = useLoad(() => api<Settings>('/me/settings'));
  const oauth = useLoad(() => api<Connection[]>('/mcp/oauth/connections'));
  const needed = useLoad(() => api<Needed[]>('/me/credentials/needed'));
  const act = useAction();
  // "Add your credential" from a stopped run arrives with ?add=<name>: the name is filled in.
  const [service, setService] = useState(() => new URLSearchParams(location.search).get('add') ?? '');
  // Which app they were sent here for, so the form stays marked out until it is stored, even if they retype it.
  const [sentFor] = useState(() => new URLSearchParams(location.search).get('add') ?? '');
  const waiting = Boolean(sentFor) && !list.data?.some((c) => c.service === sentFor);
  // The form is below the fold on a long page: bring it into view once, where the highlight is.
  useEffect(() => {
    if (waiting) document.getElementById('store-credential')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // Only on arrival, and only once the stored list is in: scrolling again while they type would fight them.
  }, [waiting]);
  const [secret, setSecret] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpService, setMcpService] = useState('');
  const [teamsUrl, setTeamsUrl] = useState('');
  const connectedTo = (svc: string) => oauth.data?.find((c) => c.service === svc)?.serverUrl;

  return (
    <Page title="My credentials & webhooks" eyebrow="PERSONAL ACCESS / VAULT & INGRESS" className="credentials-page">
      <p className="muted">
        Your own access to each app. They are encrypted on the server, used only for steps that run as you (or that you run for a teammate), and never shown again,
        not even to you. Sharing a Flow never shares them.
      </p>
      {service ? (
        <Notice>
          <strong>A Flow is waiting for your <code>{service}</code>.</strong> It is filled in for you in <em>Add or replace a credential</em> below: paste the secret and save,
          then go back to the Flow and run it.
        </Notice>
      ) : null}
      <Notice><strong>Your credentials stay private.</strong> Secrets are encrypted on the server and injected into your actions at execution time. Saved credentials are never returned by the API.</Notice>
      <ReviewsCard onChange={() => list.reload()} />
      {needed.data && needed.data.length > 0 ? (
        <Card title={<><Icon name="key"/>Needed by approved modules</>} actions={<span className={`badge ${needed.data.some(n => !n.stored && !n.optional) ? 'tone-warn' : 'tone-ok'}`}>{needed.data.filter(n => !n.stored && !n.optional).length} missing</span>}>
          <div className="table-wrap"><table><thead><tr><th>App</th><th>What to paste</th><th>Used by</th><th>Status</th><th></th></tr></thead><tbody>
            {needed.data.map(n => <tr key={n.service}><td><code>{n.service}</code></td><td>{n.label}</td><td className="muted">{n.modules.join(', ')}</td><td><span className={`badge ${n.stored ? 'tone-ok' : n.optional ? '' : 'tone-warn'}`} title={n.optional && !n.stored ? 'Works without it on public data; add it for higher limits or private data' : undefined}>{n.stored ? 'Stored' : n.optional ? 'Optional' : 'Missing'}</span></td><td>{n.stored ? null : <button className="ghost" onClick={() => { setService(n.service); document.getElementById('secret')?.focus(); }}>Add</button>}</td></tr>)}
          </tbody></table></div>
        </Card>
      ) : null}
      <div className="vault-grid">
        <Card title={<><Icon name="lock"/>Stored Credentials</>} actions={<span className="badge tone-info">{list.data?.length ?? 0} stored</span>}>
          <ErrorText>{list.error ?? oauth.error}</ErrorText>
          {!list.data ? (
            <Loading />
          ) : list.data.length === 0 ? (
            <Empty>No credentials yet.</Empty>
          ) : (
            <div className="vault-forms">
              {list.data.map(c => <article className="credential-card" key={c.service}><div className="credential-head"><span className="brand-mark"><Icon name="key" size={18}/></span><strong>{c.service}</strong><span className="badge tone-ok">Stored</span><button className="danger" disabled={act.busy} onClick={() => act.run(async () => { await api(`/me/credentials/${encodeURIComponent(c.service)}`, { method: 'DELETE' }); list.reload(); oauth.reload(); }, 'Credential removed')}>Remove</button></div><div className="request-meta"><span>Updated <When at={c.updatedAt}/></span><span>{connectedTo(c.service) ? 'OAuth connection' : 'Personal token'}</span><span>Review due <When at={c.reviewDueAt}/></span></div>{c.scopeCheck ? <div className="row"><ScopeBadge check={c.scopeCheck}/>{c.scopeCheck.status === 'broader' ? <span className="muted">A token with only {c.scopeCheck.needed?.join(', ')} would do.</span> : null}<button className="ghost" disabled={act.busy} onClick={() => act.run(async () => { await api(`/me/credentials/${encodeURIComponent(c.service)}/check`, { method: 'POST' }); list.reload(); }, 'Scopes checked')}>Check again</button></div> : null}{connectedTo(c.service) ? <code>{connectedTo(c.service)}</code> : null}<div className="secret-mask"><span>SECRET: ••••••••••••••••••••</span><span>NEVER RETURNED BY API</span></div></article>)}
            </div>
          )}
        </Card>
        <div className="vault-forms">
        <Card id="store-credential" className={waiting ? 'wanted' : undefined} title={<><Icon name="plus"/>Store or Replace a Credential</>}>
          <form
            className="form-grid"
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              act.run(async () => {
                await api(`/me/credentials/${encodeURIComponent(service)}`, { method: 'PUT', body: { secret } });
                setSecret('');
                list.reload();
                needed.reload();
              }, 'Credential saved');
            }}
          >
            <div className="field">
              <label htmlFor="svc">App (the name modules ask for, e.g. gitlab, jira, slack)</label>
              <input id="svc" value={service} pattern="[a-z0-9][a-z0-9_-]{0,39}" onChange={(e) => setService(e.target.value.toLowerCase())} required />
            </div>
            {needed.data?.find((n) => n.service === service)?.placement === 'google_service_account' ? (
              <div className="field">
                <label htmlFor="secret">Service account key (the JSON file from Google Cloud: IAM, Service accounts, Keys)</label>
                <textarea id="secret" rows={6} spellCheck={false} value={secret} placeholder='{ "type": "service_account", ... }' onChange={(e) => setSecret(e.target.value)} required />
                <small className="muted">Dittoly keeps the key and sends only short-lived access tokens with the scopes the module declares. Give the service account only the roles it needs.</small>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="secret">Token or secret</label>
                <input id="secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} required />
              </div>
            )}
            <div>
              <button type="submit" className="primary" disabled={act.busy}>
                Save
              </button>
            </div>
          </form>
          <ErrorText>{act.error}</ErrorText>
        </Card>
        <Card title={<><Icon name="bolt"/>Sign in to an MCP Server</>}>
          <p className="muted">For MCP servers that use OAuth: you sign in with your own account and Dittoly keeps the token in your credentials.</p>
          <form
            className="form-grid"
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault();
              act.run(async () => {
                const { authorizationUrl } = await api<{ authorizationUrl: string }>('/mcp/oauth/start', {
                  method: 'POST',
                  body: { url: mcpUrl, service: mcpService, returnTo: '/credentials' },
                });
                window.location.assign(authorizationUrl);
              });
            }}
          >
            <div className="field">
              <label htmlFor="mcp-url">Server URL</label>
              <input id="mcp-url" type="url" value={mcpUrl} onChange={(e) => setMcpUrl(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="mcp-svc">App (the name the imported module asks for)</label>
              <input id="mcp-svc" value={mcpService} pattern="[a-z0-9][a-z0-9_-]{0,39}" onChange={(e) => setMcpService(e.target.value.toLowerCase())} required />
            </div>
            <div>
              <button type="submit" className="primary" disabled={act.busy}>
                Sign in
              </button>
            </div>
          </form>
        </Card>
        </div>
      </div>
      <DevicesCard/>
      <McpTokensCard/>
      <StandinsCard/>
      <BreakglassCard/>
      <WebhookHub/>
      <ErrorText>{settings.error}</ErrorText>
      {settings.data ? (
        <Card title="Notifications">
          {(
            [
              ['emailNotifications', settings.data.emailConfigured, `Email me${settings.data.email ? ` (${settings.data.email})` : ' (no email address from sign-in)'}`],
              ['slackNotifications', settings.data.slackConfigured, `Send me a Slack direct message${settings.data.email ? '' : ' (needs an email address from sign-in)'}`],
              ['teamsNotifications', settings.data.teamsConfigured || settings.data.teamsPersonal, settings.data.teamsPersonal ? 'Post in my own Teams chat' : "Post in the team's Teams channel, with my name"],
              ['teamChannelNotifications', true, "Send through my teams' own notification channels (set up on the Teams page)"],
            ] as [Channel, boolean, string][]
          )
            .filter(([, configured]) => configured)
            .map(([key, , label]) => (
              <div className="field check" key={key}>
                <input
                  id={key}
                  type="checkbox"
                  checked={settings.data![key]}
                  disabled={act.busy}
                  onChange={(e) =>
                    act.run(async () => {
                      await api('/me/settings', { method: 'PUT', body: { [key]: e.target.checked } });
                      settings.reload();
                    }, 'Notification setting saved')
                  }
                />
                <label htmlFor={key}>{label} when something needs me</label>
              </div>
            ))}
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              act.run(async () => {
                await api('/me/settings', { method: 'PUT', body: { teamsWebhookUrl: teamsUrl.trim() } });
                setTeamsUrl('');
                settings.reload();
              }, 'Teams chat saved');
            }}
          >
            <div className="field">
              <label htmlFor="teams-url">My own Teams chat {settings.data.teamsPersonal ? '(set; paste a new URL to replace it)' : '(optional)'}</label>
              <input id="teams-url" type="url" placeholder="https://… Workflows webhook URL" value={teamsUrl} onChange={(e) => setTeamsUrl(e.target.value)} />
              <p className="muted">
                In Teams, add a Workflows flow from the "Send webhook alerts to a chat" template, pick the chat to post to, and paste its URL here. It is stored encrypted and
                never shown again. Your messages then go there instead of the team channel.
              </p>
            </div>
            <div className="row">
              <button type="submit" disabled={act.busy || !teamsUrl.trim()}>Save Teams chat</button>
              {settings.data.teamsPersonal ? (
                <button
                  type="button"
                  className="ghost"
                  disabled={act.busy}
                  onClick={() =>
                    act.run(async () => {
                      await api('/me/settings', { method: 'PUT', body: { teamsWebhookUrl: null } });
                      settings.reload();
                    }, 'Teams chat removed')
                  }
                >
                  Remove
                </button>
              ) : null}
            </div>
          </form>
          <p className="muted">Messages say what happened and link here. They never contain run data.</p>
        </Card>
      ) : null}
    </Page>
  );
}
