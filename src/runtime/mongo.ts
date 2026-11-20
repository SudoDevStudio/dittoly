import type { SqlParam } from './sql.js';

/**
 * Values for a MongoDB endpoint's fixed operations. They go only where the reviewed template has
 * a { "$param": "name" } placeholder, and must be single values of the declared type, so a value
 * can never become an operator (NoSQL injection).
 */

export const MONGO_READ_OPS = ['find', 'findOne', 'countDocuments', 'aggregate'] as const;
export const MONGO_WRITE_OPS = ['insertOne', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany'] as const;
export type MongoOp = (typeof MONGO_READ_OPS)[number] | (typeof MONGO_WRITE_OPS)[number];

export interface MongoParam {
  type: SqlParam['type'] | 'objectId';
  nullable?: boolean | undefined;
}

export const isPlaceholder = (v: unknown): v is { $param: string } =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as { $param?: unknown }).$param === 'string';

export type MongoValue = string | number | boolean | null | { $oid: string } | { $date: string };

/** Check the code's values against the declared types (scalars only), like checkParams for SQL. */
export function checkMongoParams(declared: Record<string, MongoParam>, values: unknown, inPipeline: boolean): { ok: true; values: Record<string, MongoValue> } | { ok: false; error: string } {
  if (values !== undefined && values !== null && (typeof values !== 'object' || Array.isArray(values))) return { ok: false, error: 'db_bad_params' };
  const given = (values ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(given)) if (!(k in declared)) return { ok: false, error: 'db_unknown_param' };
  const out: Record<string, MongoValue> = {};
  for (const [name, p] of Object.entries(declared)) {
    const v = given[name];
    if (v === undefined || v === null) {
      if (!p.nullable) return { ok: false, error: 'db_missing_param' };
      out[name] = null;
      continue;
    }
    switch (p.type) {
      case 'string':
        // In a pipeline a string starting with "$" would be read as a field path.
        if (typeof v !== 'string' || v.length > 10_000 || v.includes('\u0000') || (inPipeline && v.startsWith('$'))) return { ok: false, error: 'db_bad_param_type' };
        out[name] = v;
        break;
      case 'integer':
        if (typeof v !== 'number' || !Number.isSafeInteger(v)) return { ok: false, error: 'db_bad_param_type' };
        out[name] = v;
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, error: 'db_bad_param_type' };
        out[name] = v;
        break;
      case 'boolean':
        if (typeof v !== 'boolean') return { ok: false, error: 'db_bad_param_type' };
        out[name] = v;
        break;
      case 'timestamp':
        if (typeof v !== 'string' || Number.isNaN(Date.parse(v)) || !/^\d{4}-\d{2}-\d{2}/.test(v)) return { ok: false, error: 'db_bad_param_type' };
        out[name] = { $date: new Date(v).toISOString() };
        break;
      case 'objectId':
        if (typeof v !== 'string' || !/^[0-9a-f]{24}$/i.test(v)) return { ok: false, error: 'db_bad_param_type' };
        out[name] = { $oid: v.toLowerCase() };
        break;
    }
  }
  return { ok: true, values: out };
}

/** The template with every placeholder replaced by its value ({ $oid } / { $date } are turned into BSON by the transport). */
export function fillTemplate<T>(template: T, values: Record<string, MongoValue>): T {
  const fill = (v: unknown): unknown => {
    if (isPlaceholder(v)) return values[v.$param] ?? null;
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(template) as T;
}
