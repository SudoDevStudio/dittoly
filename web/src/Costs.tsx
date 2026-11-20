import { useState } from 'react';
import { api, post } from './api';
import { Card, ErrorText, Loading, useAction, useLoad, When } from './components';
import { Link } from './router';
import { Icon } from './ui';
import { EffortSelect, MODEL_CHANGED, ModelSelect } from './AiModelChip';

/** AI cost caps (pause and ask), the cost forecast on the review page, and the pinned model. */

export interface Cap { tokens?: number; amount?: number }
interface Spend { tokens: number; amount: number; currency: string | null }

const capText = (c: Cap, currency: string | null) =>
  [c.tokens !== undefined ? `${c.tokens.toLocaleString()} tokens` : null, c.amount !== undefined ? `${c.amount} ${currency ?? '(price table currency)'}` : null].filter(Boolean).join(' or ');

/** A run waiting at its cost cap: why, and (for its owner or an approver of its team) allow more or cancel. */
export function CostCapPanel({ runId, cap, canDecide, onDone }: { runId: string; cap: { reason: string; spent: Spend | null; cap: Cap | null }; canDecide: boolean; onDone: () => void }) {
  const act = useAction();
  const [tokens, setTokens] = useState('');
  const [amount, setAmount] = useState('');
  const more = { ...(tokens ? { tokens: Number(tokens) } : {}), ...(amount ? { amount: Number(amount) } : {}) };
  return (
    <div className="assistant-note" role="note" aria-label="Cost cap">
      <p><Icon name="shield" size={14} /> <strong>Waiting: {cap.reason}.</strong> The run goes on when its owner or an approver of its team allows more, or ends if they cancel it.</p>
      {canDecide ? (
        <div className="row">
          {cap.cap?.tokens !== undefined ? <label>More tokens <input type="number" min={1} value={tokens} onChange={(e) => setTokens(e.target.value)} /></label> : null}
          {cap.cap?.amount !== undefined ? <label>More money ({cap.spent?.currency ?? 'price table currency'}) <input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label> : null}
          <button className="primary" disabled={act.busy || !Object.keys(more).length} onClick={() => act.run(async () => (await post(`/runs/${runId}/allow-spend`, more), onDone()), 'More spend allowed; the run goes on')}>
            Allow more
          </button>
          <button className="danger" disabled={act.busy} onClick={() => act.run(async () => (await post(`/runs/${runId}/cancel`), onDone()), 'Run cancelled')}>
            Cancel run
          </button>
        </div>
      ) : null}
      <ErrorText>{act.error}</ErrorText>
    </div>
  );
}

export interface Forecast {
  model: string | null;
  currency: string | null;
  priced: boolean;
  basis: 'tests' | 'definition';
  tests: number;
  estimate: { inputTokens: number; outputTokens: number; tokens: number; amount: number | null };
  steps: { stepId: string; type: 'ai' | 'browse' | 'fix'; inputTokens: number; outputTokens: number; amount: number | null; from?: 'turns' | 'runs'; turns?: number }[];
  runs: { count: number; median: { tokens: number; amount: number | null }; p90: { tokens: number; amount: number | null } } | null;
  cap: Cap | null;
  capFromOrg: boolean;
}

const money = (n: number | null, currency: string | null) => (n === null ? '' : ` (about ${n} ${currency ?? ''})`);

/** On the review page: what one run is expected to spend on AI, and its cap. */
export function CostForecast({ forecast: f }: { forecast: Forecast }) {
  if (!f.steps.length && !f.runs) return null;
  return (
    <>
      <h2>AI cost per run</h2>
      <p aria-label="Cost forecast">
        Estimated <strong>{f.estimate.tokens.toLocaleString()} tokens</strong>{money(f.estimate.amount, f.currency)} per run,{' '}
        {f.basis === 'tests' ? `from the largest of its ${f.tests} test${f.tests === 1 ? '' : 's'}` : 'from its definition (it has no tests)'}.
        {f.runs ? <> Its last {f.runs.count} real run{f.runs.count === 1 ? '' : 's'}: median {f.runs.median.tokens.toLocaleString()} tokens{money(f.runs.median.amount, f.currency)}, 90th percentile {f.runs.p90.tokens.toLocaleString()}{money(f.runs.p90.amount, f.currency)}.</> : null}
      </p>
      <p className="muted">
        {f.cap ? <>Cap per run: {capText(f.cap, f.currency)}{f.capFromOrg ? " (the organization's default)" : ''}. A run that reaches it waits until its owner or an approver allows more.</> : 'No cap per run.'}{' '}
        {f.priced ? '' : 'The model has no price in the price table, so only tokens are estimated. '}
        Estimates use prompt sizes and recorded answers, about four characters a token; browse steps count four page looks per check.
        {f.steps.some((s) => s.type === 'fix') ? <> Fix steps: {f.steps.filter((s) => s.type === 'fix').map((s) => `${s.stepId} ${s.from === 'runs' ? 'from the median of its real runs' : `at all ${s.turns} turns of a typical size`} (${(s.inputTokens + s.outputTokens).toLocaleString()} tokens)`).join(', ')}.</> : null}
      </p>
    </>
  );
}

interface PinView { organizationModel: string | null; history: { from: string; to: string; reason: string | null; by: string; at: string; check: string | null }[]; check: { status: string; toModel: string } | null }

/** The models a run can be started with ("provider:model"), the organization's first. */
function useRunModels() {
  return useLoad(() => api<{ organization: string | null; models: string[] }>('/ai/run-models'));
}

/**
 * On the review page: the model the version's AI steps run with. A Flow follows the organization's model unless an
 * approver locked it to one; approvers lock and unlock it here.
 */
export function PinnedModel({ versionId, model, locked, pins, status, canLock, onChanged }: { versionId: string; model: string | null; locked: boolean; pins: PinView; status: string; canLock: boolean; onChanged: () => void }) {
  const models = useRunModels();
  const act = useAction();
  const [pick, setPick] = useState('');
  if (!model) return null;
  const setLock = (to: string | null) =>
    act.run(async () => {
      await api(`/flow-versions/${versionId}/model-lock`, { method: 'PUT', body: { model: to } });
      onChanged();
    }, to ? `Locked to ${to}` : "Follows the organization's model");
  return (
    <>
      <h3 className="models-run">Runs its AI steps:</h3>
      <p aria-label="AI model">
        {locked ? (
          <>Its AI steps always run with <code>{model}</code>: an approver locked it to that model.</>
        ) : (
          <>Its AI steps use the organization's model, now <code>{pins.organizationModel ?? model}</code>, and switch with it. A run can be started with another model.</>
        )}{' '}
        <span className="muted">If a model is no longer available, the step uses the organization's model instead.</span>
        {pins.check ? <span className="muted"> Check with <code>{pins.check.toModel}</code>: {pins.check.status.replace(/_/g, ' ')}.</span> : null}
      </p>
      {canLock && status === 'approved' ? (
        <div className="row">
          {locked ? (
            <button disabled={act.busy} onClick={() => setLock(null)}>Unlock: follow the organization's model</button>
          ) : (
            <>
              <select aria-label="Model to lock to" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Lock to a model…</option>
                {(models.data?.models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <button disabled={act.busy || !pick} onClick={() => setLock(pick)}>Lock</button>
            </>
          )}
        </div>
      ) : null}
      <ErrorText>{act.error}</ErrorText>
      {pins.history.length ? (
        <ul className="list">
          {pins.history.map((h) => (
            <li key={h.at}>
              <code>{h.from}</code> → <code>{h.to}</code> by {h.by} <When at={h.at} />{h.check ? ` (check ${h.check.replace(/_/g, ' ')})` : ''}{h.reason ? `: "${h.reason}"` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/** Whether a Flow's steps use the organization's AI (the steps a model choice applies to). */
export const usesOrgAi = (steps: { type: string; ai?: string }[]) => steps.some((st) => ['ai', 'browse', 'fix'].includes(st.type) && st.ai === 'organization');

/** Starting a run: which model its AI steps use (default: the Flow's own). Hidden when the Flow is locked or has none. */
export function RunModelSelect({ value, onChange, show }: { value: string; onChange: (v: string) => void; show: boolean }) {
  const models = useRunModels();
  if (!show || !models.data?.organization) return null;
  return (
    <label className="run-model">
      AI model for this run{' '}
      <select aria-label="AI model for this run" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">The Flow's model ({models.data.organization})</option>
        {models.data.models.filter((m) => m !== models.data!.organization).map((m) => <option key={m} value={m}>{m}</option>)}
      </select>
    </label>
  );
}

/** Admin settings: the default cap per run, for Flows that set none. */
export function RunCapCard() {
  const current = useLoad(() => api<{ cap: Cap | null }>('/ai/run-cap'));
  const act = useAction();
  const [tokens, setTokens] = useState('');
  const [amount, setAmount] = useState('');
  if (!current.data) return <Card title="AI cost cap per run"><Loading /></Card>;
  const save = (cap: Cap | null) => act.run(async () => (await api('/ai/run-cap', { method: 'PUT', body: { cap } }), current.reload()), cap ? 'Default cap saved' : 'Default cap removed');
  const next = { ...(tokens ? { tokens: Number(tokens) } : {}), ...(amount ? { amount: Number(amount) } : {}) };
  return (
    <Card title="AI cost cap per run">
      <p className="muted">
        Used for Flows that set no cap of their own. A run that reaches it waits, and its owner or an approver of its team allows more or cancels it. Dry runs have no cap; team budgets still stop calls outright.
      </p>
      <p>Now: {current.data.cap ? capText(current.data.cap, null) : 'no default cap'}.</p>
      <div className="row">
        <label>Tokens <input type="number" min={100} value={tokens} onChange={(e) => setTokens(e.target.value)} /></label>
        <label>Money (price table currency) <input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <button className="primary" disabled={act.busy || !Object.keys(next).length} onClick={() => save(next)}>Save</button>
        {current.data.cap ? <button disabled={act.busy} onClick={() => save(null)}>Remove</button> : null}
      </div>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

interface OrgModelView { model: string; provider: string; modelName: string | null; effort: string | null; chosen: { by: string | null; at: string } | null; configured: string; providers: string[]; checks?: number }

/** Admin settings: the organization's AI model (and provider), changed without a restart. */
export function OrgModelCard() {
  const current = useLoad(() => api<OrgModelView>('/ai/model'));
  const act = useAction();
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<string | null>(null);
  if (current.error) return null; // no organization AI on this server
  if (!current.data) return <Card title="Organization AI model"><Loading /></Card>;
  const v = current.data;
  // Untouched fields show what is in use, so the effort alone can change.
  const p = provider || v.provider;
  const m = model || (p === v.provider ? (v.modelName ?? '') : '');
  const e = effort ?? v.effort ?? '';
  const unchanged = p === v.provider && m === (v.modelName ?? '') && e === (v.effort ?? '');
  const save = (choice: { provider?: string; model: string; effort?: string } | null) =>
    act.run(async () => {
      await api<OrgModelView>('/ai/model', { method: 'PUT', body: { choice } });
      current.reload();
      window.dispatchEvent(new Event(MODEL_CHANGED));
      setModel('');
      setEffort(null);
    }, choice ? 'Model changed; approved Flows are being checked with it' : 'Back to the server configuration');
  return (
    <Card title="Organization AI model">
      <p className="muted">
        The model and effort AI steps, drafts and checks use from now on, without a restart. Approved Flows switch with it, except those an approver locked to a model; each is checked with a new model in the background, and approvers see the result under <Link to="/model-changes">Model changes</Link>.
      </p>
      <p aria-label="Organization model">
        Now: <code>{v.model}</code>{v.effort ? <> at <strong>{v.effort}</strong> effort</> : null}{v.chosen ? <>, chosen by {v.chosen.by ?? 'an admin'} <When at={v.chosen.at} /> (the server is configured with <code>{v.configured}</code>)</> : ' (from the server configuration)'}.
      </p>
      <div className="row">
        {v.providers.length > 1 ? (
          <label>Provider <select value={provider || v.provider} onChange={(e) => { setProvider(e.target.value); setModel(''); }}>{v.providers.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        ) : null}
        <ModelSelect provider={p} current={p === v.provider ? v.modelName : null} value={m} onChange={setModel} />
        <EffortSelect value={e} onChange={setEffort} />
        <button className="primary" disabled={act.busy || !m.trim() || unchanged} onClick={() => save({ ...(p !== v.provider ? { provider: p } : {}), model: m.trim(), ...(e ? { effort: e } : {}) })}>Change model</button>
        {v.chosen ? <button disabled={act.busy} onClick={() => save(null)}>Use the server configuration</button> : null}
      </div>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}
