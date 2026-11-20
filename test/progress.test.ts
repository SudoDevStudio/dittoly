import { describe, expect, it } from 'vitest';
import { progress, withProgress, type Progress } from '../src/core/progress.js';

describe('progress of long AI work', () => {
  it('reaches whoever started the work, rounded and clamped; outside it, nothing happens', async () => {
    const seen: Progress[] = [];
    progress('outside', 50);
    await withProgress((p) => seen.push(p), async () => {
      progress('drafting', 15.4);
      await new Promise((r) => setTimeout(r, 1));
      progress('saving', 140);
    });
    expect(seen).toEqual([{ step: 'drafting', percent: 15 }, { step: 'saving', percent: 100 }]);
  });

  it('a listener that throws never breaks the work', () => {
    expect(withProgress(() => { throw new Error('x'); }, () => { progress('a', 1); return 'ok'; })).toBe('ok');
  });
});
