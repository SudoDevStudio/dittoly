import { useState } from 'react';
import { DraftModelPicker } from '../DraftModel';
import { useDraftFlow } from '../FlowDrafting';
import { post } from '../api';
import { ClassificationPanel, needsAnswers, type Classification, type NeedsAnswers } from '../Classification';
import { Card, ChatBox, ErrorText, Page, useAction } from '../components';
import { Link, navigate } from '../router';
import { useTeams } from '../teams';
import { Icon } from '../ui';

/**
 * One place to start: say what to automate, or which app to connect. The AI drafts it, it may ask a question
 * first, and nothing runs until an approver approves it. The full pages (Flows, Modules) keep every other way.
 */
type Kind = 'flow' | 'module';

const STEPS = [
  ['Describe', 'Say what should happen, in your own words.'],
  ['Review', 'The AI drafts it; you read every step and what it may access.'],
  ['Approve', 'An approver signs it off. Until then nothing runs.'],
  ['Run', 'It runs the same way every time, with your own access.'],
] as const;

export function Create() {
  const { current: team } = useTeams();
  const act = useAction();
  const [kind, setKind] = useState<Kind>('flow');
  const [pending, setPending] = useState<{ request: string; classification: Classification } | null>(null);
  // A Flow drafts like on the Flows page (with the choices when a module cannot do part of it).
  const flowDraft = useDraftFlow(team ? { team } : {});

  const draft = (request: string, answers?: Record<string, string>) => {
    if (kind === 'flow') return flowDraft.draft(request);
    return act.run(async () => {
      const r = await post<{ id: string } | NeedsAnswers>('/modules/generate', { request, ...(answers ? { answers } : {}) });
      if (needsAnswers(r)) setPending({ request, classification: r.classification });
      else navigate(`/modules/${r.id}`);
    });
  };

  const choose = (k: Kind) => {
    setKind(k);
    setPending(null);
  };

  return (
    <Page
      title="Create"
      description="Start here. Say what you need; the AI drafts it, and an approver signs it off before it runs."
      actions={<DraftModelPicker type="member" id="me" what="whatever you start here" />}
    >
      <ol className="create-steps" aria-label="How it works">
        {STEPS.map(([name, text], i) => (
          <li key={name}>
            <span className="step-index">{i + 1}</span>
            <span><strong>{name}</strong><small className="muted">{text}</small></span>
          </li>
        ))}
      </ol>

      <div className="create-choices" role="radiogroup" aria-label="What do you want to create?">
        <button type="button" role="radio" aria-checked={kind === 'flow'} className={`create-choice ${kind === 'flow' ? 'selected' : ''}`} onClick={() => choose('flow')}>
          <Icon name="flow" size={22} />
          <strong>Automate a task</strong>
          <small className="muted">A Flow: steps across your apps, with sign-offs where you want them.</small>
        </button>
        <button type="button" role="radio" aria-checked={kind === 'module'} className={`create-choice ${kind === 'module' ? 'selected' : ''}`} onClick={() => choose('module')}>
          <Icon name="layers" size={22} />
          <strong>Connect an app</strong>
          <small className="muted">A module: what Dittoly may do in one app, reviewed before any Flow uses it.</small>
        </button>
        <Link to="/plans" className="create-choice">
          <Icon name="file" size={22} />
          <strong>Start from a PDF plan</strong>
          <small className="muted">Upload a plan; the AI drafts its modules and Flows.</small>
        </Link>
      </div>

      <Card title={kind === 'flow' ? 'What should happen?' : 'Which app, and what should Dittoly do in it?'}>
        <ChatBox
          key={kind}
          placeholder={kind === 'flow' ? 'e.g. every morning, get the newest video of our YouTube channel and post it to #team in Slack' : 'e.g. read the newest videos of a YouTube channel'}
          button={kind === 'flow' ? 'Draft the Flow' : 'Draft the module'}
          suggestions={
            kind === 'flow'
              ? ['List open pull requests and send a summary to Slack', 'When a Jira ticket is approved, ask for sign-off, then notify the release channel']
              : ['Post a message to a Slack channel', 'Search Jira issues with JQL']
          }
          busy={act.busy || flowDraft.busy}
          onSubmit={(text) => draft(text)}
        />
        {kind === 'flow' ? <p className="muted small">A Flow uses approved modules. If one is missing, the AI says which app to connect first.</p> : null}
        {kind === 'flow' ? flowDraft.panels : null}
        {kind === 'module' && pending ? <ClassificationPanel c={pending.classification} busy={act.busy} onBuild={(answers) => draft(pending.request, answers)} onCancel={() => setPending(null)} /> : null}
        <ErrorText>{act.error}</ErrorText>
      </Card>

      <p className="muted">
        More ways: <Link to="/flows">build a Flow step by step</Link>, <Link to="/modules">import an MCP server or paste a module</Link>, or <Link to="/marketplace">use one your organization shared</Link>.
      </p>
    </Page>
  );
}
