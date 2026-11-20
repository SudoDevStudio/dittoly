import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { FetchLike } from '../sandbox/broker.js';
import { buildApiReference } from './api-source.js';

/**
 * The docs the AI found while drafting a module, read once by Dittoly and kept in memory for the rest of that draft
 * (the rounds that fix it) and for "Try again" on the same plan item, so the AI does not search the web for the same
 * pages again and again. Dropped once the module is created, or after an hour.
 */
export class DocsCache {
  private readonly entries = new Map<string, { text: string; at: number }>();
  constructor(
    private readonly ttlMs = 60 * 60_000,
    private readonly max = 50,
  ) {}

  get(key: string): string | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return e.text;
  }

  set(key: string, text: string): void {
    this.entries.delete(key);
    // The oldest goes first when full.
    if (this.entries.size >= this.max) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { text, at: Date.now() });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }
}

const scope = new AsyncLocalStorage<string>();

/** Runs `fn` with the docs kept under `key` (a plan item: its retries share them). */
export function withDocsKey<T>(key: string, fn: () => T): T {
  return scope.run(key, fn);
}

/** The key for this draft: the plan item's when there is one, else the request's own. */
export function docsKeyFor(request: string): string {
  return scope.getStore() ?? `request:${createHash('sha256').update(request).digest('hex')}`;
}

const PAGES = 3;
const PER_PAGE = 20_000;

/**
 * The pages a draft says it used, read through the egress guard and condensed for the request (as a link given in
 * "API documentation" is). Pages its search found come first; https only; at most three; one that fails is skipped.
 */
export async function readFoundDocs(fetchFn: FetchLike, sources: { url: string; via?: string }[], request: string): Promise<string | undefined> {
  const ranked = [...sources.filter((s) => s.via === 'search'), ...sources.filter((s) => s.via !== 'search')];
  const urls = [...new Set(ranked.map((s) => s.url).filter((u) => /^https:\/\//i.test(u)))].slice(0, PAGES);
  const pages = await Promise.all(
    urls.map(async (url) => {
      try {
        const ref = await buildApiReference(fetchFn, { docsUrl: url }, request);
        return ref?.text ? `Page: ${url}\n${ref.text.slice(0, PER_PAGE)}` : null;
      } catch {
        return null;
      }
    }),
  );
  const text = pages.filter(Boolean).join('\n\n');
  return text || undefined;
}
