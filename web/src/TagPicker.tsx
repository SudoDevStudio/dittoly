import { useState } from 'react';
import { api, post } from './api';
import { useAction, useLoad } from './components';
import { Icon } from './ui';

const TAG = /^[a-z0-9][a-z0-9-]{0,29}$/;
export const normalizeTag = (s: string) => s.toLowerCase().trim().replace(/^#/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

/**
 * Tags for a marketplace listing: suggestions from what is being listed (apps,
 * how it connects, what it changes, step kinds), tags already used elsewhere,
 * and optionally the organization's AI reading the title and summary.
 */
export function TagPicker({
  value,
  onChange,
  suggestFor,
  ai,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestFor: { moduleVersionId: string } | { flowVersionId: string };
  /** Title and summary for "Suggest with AI". */
  ai?: { title: string; summary: string };
}) {
  const [text, setText] = useState('');
  const suggested = useLoad(() => api<{ tags: string[] }>(`/marketplace/tag-suggestions?${new URLSearchParams(suggestFor)}`), [JSON.stringify(suggestFor)]);
  const inUse = useLoad(() => api<{ tag: string; count: number }[]>('/marketplace/tags'));
  const [aiTags, setAiTags] = useState<string[]>([]);
  const act = useAction();
  const add = (raw: string) => {
    const t = normalizeTag(raw);
    if (!TAG.test(t) || value.includes(t) || value.length >= 10) return;
    onChange([...value, t]);
  };
  const offers = [...new Set([...(suggested.data?.tags ?? []), ...aiTags])].filter((t) => !value.includes(t));
  const listId = `tags-in-use-${'moduleVersionId' in suggestFor ? suggestFor.moduleVersionId : suggestFor.flowVersionId}`;
  return (
    <div className="tag-picker">
      <div className="tag-row" aria-label="Tags">
        {value.map((t) => (
          <button type="button" key={t} className="tag-chip selected" aria-label={`Remove tag ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
            #{t} <Icon name="close" size={12} />
          </button>
        ))}
        <input
          aria-label="Add a tag"
          list={listId}
          value={text}
          placeholder={value.length ? 'Add a tag' : 'Add tags, e.g. slack'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(text);
              setText('');
            }
          }}
          onBlur={() => { if (text.trim()) { add(text); setText(''); } }}
        />
        <datalist id={listId}>{inUse.data?.map((t) => <option key={t.tag} value={t.tag}>{`${t.count} listing${t.count === 1 ? '' : 's'}`}</option>)}</datalist>
      </div>
      {offers.length ? (
        <div className="tag-row">
          <span className="muted">Suggested:</span>
          {offers.map((t) => (
            <button type="button" key={t} className="tag-chip" onClick={() => add(t)}>
              <Icon name="plus" size={12} />#{t}
            </button>
          ))}
          {offers.length > 1 ? <button type="button" className="ghost" onClick={() => onChange([...new Set([...value, ...offers])].slice(0, 10))}>Add all</button> : null}
        </div>
      ) : null}
      {ai ? (
        <button type="button" className="ghost" disabled={act.busy || !ai.title.trim()} onClick={() => act.run(async () => {
          const r = await post<{ tags: string[] }>('/marketplace/tag-suggestions/ai', { title: ai.title, summary: ai.summary });
          setAiTags(r.tags);
          return r;
        }, (r) => (r.tags.length ? `${r.tags.length} tags suggested` : 'No tags suggested'))}>
          <Icon name="sparkles" size={14} />{act.busy ? 'Asking…' : 'Suggest with AI'}
        </button>
      ) : null}
    </div>
  );
}
