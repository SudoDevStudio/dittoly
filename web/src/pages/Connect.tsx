import { useState } from 'react';
import { api, post } from '../api';
import { Card, ErrorText, Loading, Page, useAction, useLoad } from '../components';
import { Icon, Notice } from '../ui';
import { ToolPicker, type Scopes, type Tool } from './Agents';

/**
 * The consent page for OAuth sign-in from an AI app (Claude, ChatGPT, Copilot Studio...). The
 * person sees which app asks and where it sends them back, picks what it may use, and approving
 * makes an agent, listed on the Agents page like any other. Then the browser goes back to the app.
 */

interface ConsentRequest {
  id: string;
  client: { id: string; name: string; kind: 'metadata' | 'registered' };
  redirectUri: string;
  redirectHost: string;
  loopback: boolean;
  allowedAs: string;
  expiresAt: string;
}

const EXPIRY = [[1, '1 day'], [7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '1 year (the longest)']] as const;

export function Connect({ id }: { id: string }) {
  const req = useLoad(() => api<ConsentRequest>(`/oauth/requests/${id}`), [id]);
  const tools = useLoad(() => api<Tool[]>('/me/mcp-tools'));
  const act = useAction();
  const [scopes, setScopes] = useState<Scopes>({ tools: {}, drafting: false });
  const [name, setName] = useState<string | null>(null);
  const [days, setDays] = useState(90);
  if (req.error) {
    return (
      <Page title="Connect an app" eyebrow="WORKSPACE / AGENTS / SIGN-IN">
        <Card><ErrorText>{req.error}</ErrorText></Card>
      </Page>
    );
  }
  if (!req.data) return <Loading />;
  const r = req.data;
  const agentName = name ?? r.client.name;
  // Once answered, the browser goes back to the app with the code (or with "access denied").
  const answer = (path: 'approve' | 'deny') =>
    act.run(async () => {
      const out = await post<{ redirectTo: string }>(`/oauth/requests/${r.id}/${path}`, path === 'approve' ? { name: agentName.trim(), scopes, expiresInDays: days } : {});
      location.assign(out.redirectTo);
    });
  return (
    <Page title={`${r.client.name} wants to connect`} eyebrow="WORKSPACE / AGENTS / SIGN-IN" description="Approving makes an AI agent that acts for you, with your own access, using only what you pick here. You can change or revoke it any time on the Agents page.">
      <Card title={<><Icon name="globe" />Where you go back to</>}>
        <p className="connect-host"><code>{r.redirectHost}</code></p>
        <p className="muted">
          After you answer, Dittoly sends you to <code>{r.redirectUri}</code>. Only continue if you started connecting from {r.client.name} just now.
          {r.client.kind === 'registered' ? ` The app chose its name itself; what Dittoly checks is the address above (allowed as ${r.allowedAs}).` : ` The app is identified by ${r.client.id}.`}
        </p>
        {r.loopback ? (
          <Notice>
            <strong>This app runs on your own computer.</strong> The answer goes to a program on this machine, and any program running here could claim to be {r.client.name}. Approve only if you
            started this yourself from {r.client.name} (for example Claude Code) a moment ago.
          </Notice>
        ) : null}
      </Card>
      <Card title={<><Icon name="sparkles" />What it may use</>}>
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            void answer('approve');
          }}
        >
          <div className="field"><label htmlFor="connect-name">Agent name (shown on the Agents page)</label><input id="connect-name" required maxLength={80} value={agentName} onChange={(e) => setName(e.target.value)} /></div>
          {tools.data ? <ToolPicker tools={tools.data} scopes={scopes} onChange={setScopes} /> : <Loading />}
          <div className="field">
            <label htmlFor="connect-days">Works for</label>
            <select id="connect-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {EXPIRY.map(([d, label]) => <option key={d} value={d}>{label}</option>)}
            </select>
            <span className="muted">After that the app has to be connected again. You can extend it on the Agents page.</span>
          </div>
          <div className="row">
            <button type="submit" className="primary" disabled={act.busy || !agentName.trim()}>Allow</button>
            <button type="button" className="danger" disabled={act.busy} onClick={() => void answer('deny')}>Deny</button>
          </div>
          <ErrorText>{act.error}</ErrorText>
        </form>
      </Card>
    </Page>
  );
}

