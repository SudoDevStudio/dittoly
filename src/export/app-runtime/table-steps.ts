import { coerce, LIMITS } from '../../runtime/values.js';
import { EngineError, type TableDef } from './engine.js';
import type { Scope, TableStepCode } from './flow.js';
import type { Store } from './store.js';

/** Table steps: rows kept in the app's state store. Only apps whose Flows use a table carry this file. */

export async function tableStep(t: TableDef, def: TableStepCode, scope: Scope, store: Store): Promise<unknown> {
  const keyOf = () => {
    const k = def.key ? def.key(scope) : undefined;
    const s = k === null || k === undefined ? '' : String(k);
    if (!s || s.length > LIMITS.keyLength) throw new EngineError('invalid_key', 400);
    return s;
  };
  const shape = (key: string, values: Record<string, unknown>) => {
    const row: Record<string, unknown> = { [t.keyColumn]: key };
    for (const c of t.columns) row[c.name] = values[c.name] ?? null;
    return row;
  };
  const put = async (key: string, values: Record<string, unknown>) => {
    const clean: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(values ?? {})) {
      if (name === t.keyColumn) continue;
      const c = t.columns.find((x) => x.name === name);
      if (!c) throw new EngineError('unknown_column', 400);
      clean[name] = coerce(c.type, v, name);
    }
    const found = await store.tableGet(t.name, key);
    if (!found && (await store.tableRows(t.name)).length >= LIMITS.rows) throw new EngineError('table_full', 409);
    const merged = { ...(found ?? {}), ...clean };
    if (JSON.stringify(merged).length > LIMITS.rowBytes) throw new EngineError('row_too_large', 400);
    await store.tablePut(t.name, key, merged);
    return { row: shape(key, merged), created: !found };
  };
  switch (def.op) {
    case 'get': {
      const key = keyOf();
      const row = await store.tableGet(t.name, key);
      return { found: row !== null, row: row ? shape(key, row) : null };
    }
    case 'put':
      return put(keyOf(), (def.values ? def.values(scope) : {}) as Record<string, unknown>);
    case 'delete':
      return { deleted: await store.tableDelete(t.name, keyOf()) };
    case 'increment': {
      const c = t.columns.find((x) => x.name === def.column);
      if (!c || c.type !== 'number') throw new EngineError('invalid_column', 400);
      const by = coerce('number', def.by ? def.by(scope) : 1, 'by') as number;
      const key = keyOf();
      const cur = (await store.tableGet(t.name, key)) ?? {};
      const value = (typeof cur[c.name] === 'number' ? (cur[c.name] as number) : 0) + by;
      const { row } = await put(key, { [c.name]: value });
      return { value, row };
    }
    case 'list': {
      let rows = (await store.tableRows(t.name)).map((r) => shape(r.key, r.row));
      if (def.where) {
        const col = def.where.column;
        const type = col === t.keyColumn ? 'text' : t.columns.find((c) => c.name === col)?.type;
        if (!type) throw new EngineError('unknown_column', 400);
        const want = coerce(type, def.where.equals(scope), col);
        rows = rows.filter((r) => r[col] === want);
      }
      rows = rows.slice(0, Math.min(def.limit ?? 100, LIMITS.list));
      return { rows, count: rows.length };
    }
  }
}
