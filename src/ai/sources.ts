import { cleanSources, looseJson, type WebSource } from '../runtime/ai.js';

/**
 * Where a draft's information came from, for the reviewer: pages the provider's own web search returned or fetched
 * ("search", seen by Dittoly), and pages the AI names as what it relied on ("ai": the only kind the Claude and Codex
 * CLIs can report, and not checked by Dittoly).
 */
export interface DraftSource extends WebSource {
  via: 'search' | 'ai';
}

/** sourcesJson: [{ url, title }] the AI wrote, read leniently (absent or broken is none). */
export function namedSources(v: unknown): WebSource[] {
  if (typeof v !== 'string' || !v.trim()) return [];
  try {
    const list: unknown = looseJson(v);
    return Array.isArray(list) ? cleanSources(list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object'), 15) : [];
  } catch {
    return [];
  }
}

/** Both kinds together, a page found by search listed once (as "search"). */
export function draftSources(searched: WebSource[], named: WebSource[]): DraftSource[] {
  const out: DraftSource[] = searched.slice(0, 30).map((s) => ({ ...s, via: 'search' as const }));
  for (const s of named) if (!out.some((o) => o.url === s.url)) out.push({ ...s, via: 'ai' });
  return out;
}

/** A collector to pass as onSources: what the provider reports across all calls of one draft. */
export function sourceCollector(): { onSources: (s: WebSource[]) => void; found: WebSource[] } {
  const found: WebSource[] = [];
  return { found, onSources: (s) => found.push(...s.filter((x) => !found.some((f) => f.url === x.url))) };
}
