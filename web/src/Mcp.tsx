import { api } from './api';
import { Card, ErrorText, Pre, useAction, useLoad } from './components';
import { Link } from './router';
import { Icon, Notice } from './ui';

/**
 * Dittoly as an MCP server: AI assistants (Claude, Cursor, ...) run approved Flows as tools,
 * as the person whose MCP token they use. Each Flow's owner decides whether it is offered.
 */

/** On a Flow's page: offer it to AI assistants or not. */
export function McpFlowCard({ flowId, canChange }: { flowId: string; canChange: boolean }) {
  const state = useLoad(() => api<{ enabled: boolean; tool: string | null }>(`/flows/${flowId}/mcp`), [flowId]);
  const act = useAction();
  if (!state.data) return null;
  return (
    <Card title={<><Icon name="sparkles" />AI assistants</>} actions={<span className={`badge ${state.data.enabled ? 'tone-ok' : ''}`}>{state.data.enabled ? 'Offered' : 'Not offered'}</span>}>
      <p className="muted">
        When this is on, AI assistants connected to Dittoly (Claude, Cursor and others, through MCP) can run the approved version of this Flow as a tool
        {state.data.tool ? <> called <code>{state.data.tool}</code></> : null}, as the person using it, with their own access. Sign-offs and forms still wait for a person here.
      </p>
      {canChange ? (
        <button
          disabled={act.busy}
          onClick={() => act.run(async () => (await api(`/flows/${flowId}/mcp`, { method: 'PUT', body: { enabled: !state.data!.enabled } }), state.reload()), state.data!.enabled ? 'No longer offered to AI assistants' : 'Offered to AI assistants')}
        >{state.data.enabled ? 'Stop offering to AI assistants' : 'Offer to AI assistants'}</button>
      ) : <p className="muted">Only the Flow's owner or a team admin can change this.</p>}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

/** On the credentials page: a pointer to the Agents page, where assistants are connected. */
export function McpTokensCard() {
  const agents = useLoad(() => api<{ state: string }[]>('/agents'));
  const active = agents.data?.filter((a) => a.state === 'active').length ?? 0;
  return (
    <Card title={<><Icon name="sparkles" />AI assistants (MCP)</>} actions={<span className="badge tone-info">{active} active agents</span>}>
      <p className="muted">Each AI assistant you connect is an agent acting for you: it uses only the Flows you pick for it, until it expires, and every call it makes is recorded.</p>
      <Notice><strong>Save AI work as a Flow.</strong> After an assistant does a task for you, ask it to "save this as a Flow". It drafts a Flow (and any module it needs) with Dittoly's rules, and it waits for approval like any other draft. From then on the task runs without an AI and without spending tokens.</Notice>
      <Link to="/agents" className="card-link">Manage your agents <Icon name="arrow" size={16} /></Link>
    </Card>
  );
}

export interface AssistantDraft { name: string | null; token: string; explanation: string }

/** For reviewers: a draft an AI assistant saved over MCP, for the member who owns the token. */
export function AssistantNote({ draft, what }: { draft: AssistantDraft; what: 'Flow' | 'module' }) {
  return (
    <div className="assistant-note" role="note">
      <p><Icon name="sparkles" size={14} /> This {what} was drafted by {draft.name ? <strong>{draft.name}</strong> : 'an AI assistant'} from a task it did, and saved through the MCP token <strong>{draft.token}</strong>. Check it like any other draft.</p>
      <p className="muted">The assistant's explanation:</p>
      <Pre>{draft.explanation}</Pre>
    </div>
  );
}
