/**
 * Values for a database endpoint's fixed queries: checked against the declared parameter types
 * and always sent to the database as bound parameters, never pasted into the SQL text.
 */

export type Dialect = 'postgres' | 'mysql' | 'mssql';

export type SqlParamType = 'string' | 'integer' | 'number' | 'boolean' | 'timestamp';
export interface SqlParam {
  type: SqlParamType;
  /** null may be passed. */
  nullable?: boolean | undefined;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
export const MAX_SQL_STRING = 10_000;

/** Check the values the code passes against the declared parameter types. Scalars only. */
export function checkParams(declared: Record<string, SqlParam>, values: unknown): { ok: true; values: Record<string, string | number | boolean | null> } | { ok: false; error: string } {
  if (values !== undefined && values !== null && (typeof values !== 'object' || Array.isArray(values))) return { ok: false, error: 'db_bad_params' };
  const given = (values ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(given)) if (!(k in declared)) return { ok: false, error: 'db_unknown_param' };
  const out: Record<string, string | number | boolean | null> = {};
  for (const [name, p] of Object.entries(declared)) {
    const v = given[name];
    if (v === undefined || v === null) {
      if (!p.nullable) return { ok: false, error: 'db_missing_param' };
      out[name] = null;
      continue;
    }
    const ok =
      p.type === 'string' ? typeof v === 'string' && v.length <= MAX_SQL_STRING && !v.includes('\u0000')
      : p.type === 'integer' ? typeof v === 'number' && Number.isSafeInteger(v)
      : p.type === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : p.type === 'boolean' ? typeof v === 'boolean'
      : typeof v === 'string' && TIMESTAMP.test(v) && !Number.isNaN(Date.parse(v.replace(' ', 'T')));
    if (!ok) return { ok: false, error: 'db_bad_param_type' };
    out[name] = v as string | number | boolean;
  }
  return { ok: true, values: out };
}

/**
 * Turn ":name" placeholders into the driver's own: $1 (Postgres), ? (MySQL) or @p1 (SQL Server).
 * Only placeholder tokens are rewritten; strings, quoted names and "::" casts are left alone.
 */
export function bindSql(sql: string, dialect: Dialect, values: Record<string, string | number | boolean | null>): { text: string; values: (string | number | boolean | null)[] } {
  const order: string[] = [];
  const out: (string | number | boolean | null)[] = [];
  let text = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const quote = c === "'" ? "'" : c === '"' ? '"' : c === '`' && dialect === 'mysql' ? '`' : c === '[' && dialect === 'mssql' ? ']' : null;
    if (quote) {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      text += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === ':' && sql[i + 1] === ':') {
      text += '::';
      i += 2;
      continue;
    }
    const m = c === ':' ? /^:([a-z][a-z0-9_]*)/.exec(sql.slice(i)) : null;
    if (m) {
      const name = m[1]!;
      if (dialect === 'mysql') {
        out.push(values[name] ?? null);
        text += '?';
      } else {
        let k = order.indexOf(name);
        if (k === -1) {
          order.push(name);
          out.push(values[name] ?? null);
          k = order.length - 1;
        }
        text += dialect === 'postgres' ? `$${k + 1}` : `@p${k + 1}`;
      }
      i += m[0].length;
      continue;
    }
    // A word right before a placeholder-like sequence (e.g. "a:b") never happens in checked SQL.
    text += c;
    i++;
  }
  return { text: text.trim().replace(/;$/, ''), values: out };
}
