import { isPlaceholder, MONGO_READ_OPS, MONGO_WRITE_OPS, type MongoOp, type MongoParam } from '../runtime/mongo.js';

export { checkMongoParams, fillTemplate, MONGO_READ_OPS, MONGO_WRITE_OPS, type MongoOp, type MongoParam, type MongoValue } from '../runtime/mongo.js';

/**
 * Fixed MongoDB operations for database endpoints, the MongoDB counterpart of sql.ts.
 *
 * Every operation is declared in the manifest and reviewed. Its filter, update, document or
 * pipeline is a JSON template; values from the code go only where the template has a
 * { "$param": "name" } placeholder, and must be single values of the declared type, so a value
 * can never become an operator such as { "$gt": "" } or { "$where": "..." } (NoSQL injection).
 *
 * - no operators that run JavaScript ($where, $function, $accumulator) or write elsewhere
 *   ($out, $merge), and no server or session introspection stages;
 * - "read" operations are find, findOne, countDocuments and aggregate;
 * - "write" operations are insertOne, updateOne, updateMany, deleteOne and deleteMany; updates
 *   use update operators only, and updateMany and deleteMany need a filter;
 * - a placeholder cannot be a key, a regular expression, or a field path in a pipeline.
 */

/** Anywhere in a template. */
const FORBIDDEN_OPERATORS = new Set([
  '$where', '$function', '$accumulator', '$out', '$merge', '$currentOp', '$listSessions', '$listLocalSessions', '$listSampledQueries',
  '$listSearchIndexes', '$planCacheStats', '$indexStats', '$collStats', '$changeStream', '$changeStreamSplitLargeEvent', '$querySettings', '$shardedDataDistribution',
]);
const UPDATE_OPERATORS = new Set(['$set', '$unset', '$inc', '$mul', '$min', '$max', '$push', '$pull', '$pullAll', '$addToSet', '$pop', '$currentDate', '$setOnInsert']);

export interface MongoOperation {
  id: string;
  effect: 'read' | 'write';
  collection: string;
  op: MongoOp;
  filter?: Record<string, unknown> | undefined;
  projection?: Record<string, unknown> | undefined;
  sort?: Record<string, unknown> | undefined;
  pipeline?: Record<string, unknown>[] | undefined;
  document?: Record<string, unknown> | undefined;
  update?: Record<string, unknown> | undefined;
  upsert?: boolean | undefined;
  params: Record<string, MongoParam>;
  maxRows: number;
}
/** Check one declared operation. Returns problems and the placeholder names used. */
export function checkMongoOperation(o: MongoOperation): { problems: string[]; params: string[] } {
  const problems: string[] = [];
  const params: string[] = [];
  const reads: readonly string[] = MONGO_READ_OPS;
  const writes: readonly string[] = MONGO_WRITE_OPS;
  if (o.effect === 'read' && !reads.includes(o.op)) problems.push(`a read operation must be ${MONGO_READ_OPS.join(', ')}`);
  if (o.effect === 'write' && !writes.includes(o.op)) problems.push(`a write operation must be ${MONGO_WRITE_OPS.join(', ')}`);

  const walk = (v: unknown, where: string, ctx: { pipeline: boolean; parentKey: string | null }) => {
    if (isPlaceholder(v)) {
      params.push(v.$param);
      if (ctx.parentKey === '$regex' || ctx.parentKey === '$options') problems.push(`${where}: a parameter cannot be a regular expression`);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${where}[${i}]`, { ...ctx, parentKey: ctx.parentKey }));
      return;
    }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === '$param') problems.push(`${where}: "$param" must be the only key of a placeholder`);
        if (FORBIDDEN_OPERATORS.has(k)) problems.push(`${k} is not allowed`);
        if (k === '$lookup' || k === '$graphLookup' || k === '$unionWith') {
          const from = k === '$unionWith' ? (typeof x === 'string' ? x : (x as { coll?: unknown })?.coll) : (x as { from?: unknown })?.from;
          if (typeof from !== 'string') problems.push(`${k} must name its collection literally`);
        }
        if (k.length > 200 || k.includes('\u0000')) problems.push(`${where}: field name too long or invalid`);
        walk(x, `${where}.${k}`, { ...ctx, parentKey: k });
      }
      return;
    }
    if (typeof v === 'string' && v.includes('\u0000')) problems.push(`${where}: text cannot contain NUL`);
  };

  const has = (x: unknown) => x !== undefined && x !== null;
  const needs = (field: keyof MongoOperation, ops: MongoOp[]) => {
    if (has(o[field]) && !ops.includes(o.op)) problems.push(`${o.op} does not take "${field}"`);
  };
  needs('filter', ['find', 'findOne', 'countDocuments', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany']);
  needs('projection', ['find', 'findOne']);
  needs('sort', ['find', 'findOne']);
  needs('pipeline', ['aggregate']);
  needs('document', ['insertOne']);
  needs('update', ['updateOne', 'updateMany']);
  needs('upsert', ['updateOne', 'updateMany']);

  if (o.filter) walk(o.filter, 'filter', { pipeline: false, parentKey: null });
  if (o.projection) walk(o.projection, 'projection', { pipeline: false, parentKey: null });
  if (o.sort) {
    walk(o.sort, 'sort', { pipeline: false, parentKey: null });
    for (const [k, v] of Object.entries(o.sort)) if (v !== 1 && v !== -1) problems.push(`sort.${k} must be 1 or -1`);
  }
  if (o.op === 'aggregate') {
    if (!o.pipeline?.length) problems.push('aggregate needs a pipeline');
    for (const [i, stage] of (o.pipeline ?? []).entries()) {
      const keys = Object.keys(stage ?? {});
      if (keys.length !== 1 || !keys[0]!.startsWith('$')) problems.push(`pipeline[${i}] must be one stage such as { "$match": {...} }`);
      walk(stage, `pipeline[${i}]`, { pipeline: true, parentKey: null });
    }
  }
  if (o.op === 'insertOne') {
    if (!o.document) problems.push('insertOne needs a document');
    else {
      for (const k of Object.keys(o.document)) if (k.startsWith('$')) problems.push(`document.${k}: field names cannot start with "$"`);
      walk(o.document, 'document', { pipeline: false, parentKey: null });
    }
  }
  if (o.op === 'updateOne' || o.op === 'updateMany') {
    const keys = Object.keys(o.update ?? {});
    if (!keys.length) problems.push(`${o.op} needs an update such as { "$set": {...} }`);
    for (const k of keys) if (!UPDATE_OPERATORS.has(k)) problems.push(`update.${k}: only update operators (${[...UPDATE_OPERATORS].join(', ')}) are allowed`);
    walk(o.update, 'update', { pipeline: false, parentKey: null });
  }
  if ((o.op === 'updateMany' || o.op === 'deleteMany') && !Object.keys(o.filter ?? {}).length) problems.push(`${o.op} needs a filter`);
  return { problems: [...new Set(problems)], params };
}
