import { describe, expect, it } from 'vitest';
import { sortRunnable } from '../web/src/run-sort.js';

type Runnable = { name: string; approvedAt: string | null; versionId: string };

/** Run a Flow lists Flows by when they were added (approved) or by name, either way round. */
const flow = (name: string, approvedAt: string | null) => ({ name, approvedAt, versionId: name }) as Runnable;
const list = [flow('beta', '2026-11-02T00:00:00Z'), flow('Alpha', '2026-11-03T00:00:00Z'), flow('gamma', null), flow('delta', '2026-11-03T00:00:00Z')];
const names = (l: Runnable[]) => l.map((r) => r.name);

describe('sorting the Flows you can run', () => {
  it('recently added: newest first (DESC) or oldest first (ASC); ties by name', () => {
    expect(names(sortRunnable(list, 'added', 'desc'))).toEqual(['Alpha', 'delta', 'beta', 'gamma']);
    expect(names(sortRunnable(list, 'added', 'asc'))).toEqual(['gamma', 'beta', 'Alpha', 'delta']);
  });

  it('by name, ignoring case: A to Z (ASC) or Z to A (DESC)', () => {
    expect(names(sortRunnable(list, 'name', 'asc'))).toEqual(['Alpha', 'beta', 'delta', 'gamma']);
    expect(names(sortRunnable(list, 'name', 'desc'))).toEqual(['gamma', 'delta', 'beta', 'Alpha']);
  });

  it('leaves the list it was given as it was', () => {
    const before = names(list);
    sortRunnable(list, 'name', 'desc');
    expect(names(list)).toEqual(before);
  });
});
