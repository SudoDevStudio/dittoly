import { useContext, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ErrorText, useAction, useLoad } from './components';
import { MeContext } from './context';
import { Link } from './router';
import { Icon } from './ui';

/** What GET /api/ai/model answers: everyone gets the model in use; admins also get what they can switch to. */
interface ModelView {
  provider: string;
  model: string;
  modelName: string | null;
  effort?: string | null;
  chosen?: { by: string | null; at: string } | null;
  configured?: string;
  providers?: string[];
  known?: Record<string, string[]>;
}

/** Effort levels, easiest first (the Claude API's names; each provider maps them to its own). */
export const EFFORT_OPTIONS: [string, string][] = [
  ['', "Model's default"],
  ['low', 'Low: fastest, cheapest'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
  ['max', 'Max: most thorough, slowest'],
];

/** The effort picker, shared by the top bar and the Admin page. */
export function EffortSelect({ value, onChange }: { value: string; onChange: (effort: string) => void }) {
  return (
    <label className="field">
      <span>Effort</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>{EFFORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
    </label>
  );
}

/** Sent by the header and the Admin page when the organization's model changes, so both show the new one. */
export const MODEL_CHANGED = 'dittoly:ai-model-changed';

/** The top bar's middle: which AI provider and model Dittoly uses now; admins switch it here. */
export function AiModelChip() {
  const ctx = useContext(MeContext);
  const admin = ctx?.me.role === 'admin';
  const current = useLoad(() => api<ModelView>('/ai/model'));
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reload = () => current.reload();
    window.addEventListener(MODEL_CHANGED, reload);
    return () => window.removeEventListener(MODEL_CHANGED, reload);
  }, [current.reload]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (current.loading && !current.data) return null;
  const v = current.data;
  const label = v ? <><span className="ai-chip-provider">{v.provider}</span><span className="ai-chip-model">{v.modelName ?? "provider's model"}</span>{v.effort ? <span className="ai-chip-effort">{v.effort}</span> : null}</> : <span className="ai-chip-model">not configured</span>;
  // Names the model only when one is set: the provider's own default is just the provider.
  const title = v ? `AI in use: ${v.provider}${v.modelName ? ` · ${v.modelName}` : ''}${v.effort ? `, ${v.effort} effort` : ''}${admin ? ' (click to switch)' : ''}` : 'No AI provider is configured on this server';
  if (!admin || !v) {
    return <span className="ai-chip" title={title} aria-label={title}><Icon name="sparkles" size={15} />{label}</span>;
  }
  return (
    <div className="ai-chip-wrap" ref={box}>
      <button type="button" className="ai-chip" title={title} aria-label={title} aria-expanded={open} aria-haspopup="dialog" onClick={() => { if (!open) current.reload(); setOpen(!open); }}>
        <Icon name="sparkles" size={15} />{label}<span className="ai-chip-caret"><Icon name="chevron" size={13} /></span>
      </button>
      {open ? <ModelPicker view={v} onDone={() => { setOpen(false); current.reload(); }} /> : null}
    </div>
  );
}

/** A provider's models as a list (what it offers, the price table's and the ones in use), or "Other model…" to type one. */
export function ModelSelect({ provider, current, value, onChange }: { provider: string; current: string | null; value: string; onChange: (model: string) => void }) {
  const list = useLoad(() => api<{ models: string[]; listed: boolean }>(`/ai/models?provider=${encodeURIComponent(provider)}`), [provider]);
  const [other, setOther] = useState(false);
  const models = list.data?.models ?? [];
  useEffect(() => setOther(false), [provider]);
  if (list.loading && !list.data) return <p className="muted">Loading models…</p>;
  const typing = other || (!list.loading && models.length === 0);
  return (
    <>
      {models.length ? (
        <label className="field">
          <span>Model</span>
          <select
            value={typing ? '__other' : value}
            onChange={(e) => {
              const v = e.target.value;
              setOther(v === '__other');
              onChange(v === '__other' ? '' : v);
            }}
          >
            <option value="">Choose a model…</option>
            {models.map((m) => <option key={m} value={m}>{m}{m === current ? ' (in use)' : ''}</option>)}
            <option value="__other">Other model…</option>
          </select>
        </label>
      ) : null}
      {typing ? (
        <label className="field">
          <span>{models.length ? 'Model name' : 'Model'}</span>
          <input value={value} placeholder="model id" onChange={(e) => onChange(e.target.value)} />
        </label>
      ) : null}
      {list.data && !list.data.listed ? <p className="muted small">{provider} does not list its models here; type the name, or add it to the price table to see it in this list.</p> : null}
    </>
  );
}

function ModelPicker({ view, onDone }: { view: ModelView; onDone: () => void }) {
  const act = useAction();
  const [provider, setProvider] = useState(view.provider);
  const [model, setModel] = useState(view.modelName ?? '');
  const [effort, setEffort] = useState(view.effort ?? '');
  const unchanged = provider === view.provider && model === (view.modelName ?? '') && effort === (view.effort ?? '');
  const save = (choice: { provider?: string; model: string; effort?: string } | null) =>
    act
      .run(
        () => api<ModelView>('/ai/model', { method: 'PUT', body: { choice } }),
        choice ? `Now using ${provider}:${choice.model}${choice.effort ? ` at ${choice.effort} effort` : ''}` : 'Back to the server configuration',
      )
      .then((r) => {
        if (!r) return;
        window.dispatchEvent(new Event(MODEL_CHANGED));
        onDone();
      });
  return (
    <div className="ai-chip-menu" role="dialog" aria-label="Switch the AI model">
      <strong>AI model</strong>
      <p className="muted">
        Now <code>{view.model}</code>{view.chosen ? `, chosen by ${view.chosen.by ?? 'an admin'}` : ' (server configuration)'}.
        New drafts and AI steps use the new model and effort at once. Approved Flows switch too, except those an approver locked to a model; each is checked with the new model in the background (see <Link to="/model-changes" onClick={onDone}>Model changes</Link>).
      </p>
      {(view.providers?.length ?? 0) > 1 ? (
        <label className="field">
          <span>Provider</span>
          <select value={provider} onChange={(e) => { setProvider(e.target.value); setModel(e.target.value === view.provider ? (view.modelName ?? '') : ''); }}>{view.providers!.map((p) => <option key={p} value={p}>{p}</option>)}</select>
        </label>
      ) : null}
      <ModelSelect provider={provider} current={provider === view.provider ? view.modelName : null} value={model} onChange={setModel} />
      <EffortSelect value={effort} onChange={setEffort} />
      <div className="row">
        <button type="button" className="primary" disabled={act.busy || !model.trim() || unchanged} onClick={() => save({ ...(provider !== view.provider ? { provider } : {}), model: model.trim(), ...(effort ? { effort } : {}) })}>Switch</button>
        {view.chosen ? <button type="button" className="ghost" disabled={act.busy} onClick={() => save(null)}>Use server configuration</button> : null}
      </div>
      <ErrorText>{act.error}</ErrorText>
    </div>
  );
}
