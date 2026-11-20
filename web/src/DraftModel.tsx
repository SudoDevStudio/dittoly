import { useState } from 'react';
import { api } from './api';
import { ErrorText, useAction, useLoad } from './components';
import { EFFORT_OPTIONS } from './AiModelChip';
import { Icon } from './ui';

/**
 * Which model drafts this one thing. The organization has a model for everything, and that is the right default
 * and the wrong answer often enough: a Flow that keeps coming back wrong wants the bigger model, a module nobody
 * argues about can have the cheap one. Whoever may draft it may choose, the choice stays with it, and "the
 * organization's" puts it back. It decides who writes the draft, nothing else — a run's AI steps follow the model
 * its Flow was approved with.
 */
interface View {
  chosen: { provider?: string; model: string; effort?: string; by: string | null; at: string } | null;
  inUse: { provider?: string; model: string; effort?: string } | null;
  organization: string | null;
}

export function DraftModelPicker({ type, id, what }: { type: 'flow' | 'module' | 'plan' | 'member'; id: string; what: string }) {
  const view = useLoad(() => api<View>(`/ai/draft-model/${type}/${id}`), [type, id]);
  const models = useLoad(() => api<{ provider: string; models: string[] }>('/ai/models').catch(() => ({ provider: '', models: [] })));
  const act = useAction();
  const [open, setOpen] = useState(false);
  const chosen = view.data?.chosen ?? null;
  const label = chosen ? `${chosen.model}${chosen.effort ? ` · ${chosen.effort}` : ''}` : view.data?.organization ?? 'the organization’s model';

  const save = (model: string | null, effort: string) =>
    act.run(async () => {
      await api(`/ai/draft-model/${type}/${id}`, { method: 'PUT', body: { choice: model ? { model, ...(effort ? { effort } : {}) } : null } });
      setOpen(false);
      view.reload();
    }, model ? `Drafted with ${model} from now on` : 'Back to the organization’s model');

  return (
    <div className="draft-model">
      <button type="button" className="ghost small" onClick={() => setOpen(!open)} title={`Which model drafts ${what}`}>
        <Icon name="sparkles" size={13} />Drafted with <code>{label}</code>{chosen ? '' : ' (default)'}
      </button>
      {open ? (
        <div className="draft-model-box">
          <p className="muted">
            Which model writes the next draft of {what}. It does not change what runs: a Flow's AI steps follow the model it was approved with.
          </p>
          <label className="field">
            <span>Model</span>
            <select
              value={chosen?.model ?? ''}
              disabled={act.busy}
              onChange={(e) => save(e.target.value || null, chosen?.effort ?? '')}
            >
              <option value="">The organization’s model{view.data?.organization ? ` (${view.data.organization})` : ''}</option>
              {(models.data?.models ?? []).map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Effort</span>
            <select value={chosen?.effort ?? ''} disabled={act.busy || !chosen} onChange={(e) => save(chosen?.model ?? null, e.target.value)}>
              {EFFORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {chosen?.by ? <p className="muted">Chosen by {chosen.by}.</p> : null}
          <ErrorText>{act.error}</ErrorText>
        </div>
      ) : null}
    </div>
  );
}
