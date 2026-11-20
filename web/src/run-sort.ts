/** How Run a Flow orders its list: by when a Flow was added (its version approved) or by name, either way round. */
export type SortBy = 'added' | 'name';
export type Dir = 'asc' | 'desc';
interface Sortable {
  name: string;
  approvedAt: string | null;
}

const SORT_KEY = 'run_hub_sort';

/** The order last chosen (newest first when none was). */
export function readSort(): { by: SortBy; dir: Dir } {
  try {
    const [by, dir] = (localStorage.getItem(SORT_KEY) ?? '').split(':');
    if ((by === 'added' || by === 'name') && (dir === 'asc' || dir === 'desc')) return { by, dir };
  } catch {
    // Only a convenience.
  }
  return { by: 'added', dir: 'desc' };
}

export function writeSort(s: { by: SortBy; dir: Dir }): void {
  try {
    localStorage.setItem(SORT_KEY, `${s.by}:${s.dir}`);
  } catch {
    // Only a convenience.
  }
}

/** A sorted copy: by added time or name (case ignored); ties by name. A Flow with no approval time counts as oldest. */
export function sortRunnable<T extends Sortable>(list: T[], by: SortBy, dir: Dir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  const byName = (a: T, b: T) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  const at = (r: T) => (r.approvedAt ? Date.parse(r.approvedAt) : 0);
  return [...list].sort((a, b) => (by === 'name' ? sign * byName(a, b) : sign * (at(a) - at(b)) || byName(a, b)));
}
