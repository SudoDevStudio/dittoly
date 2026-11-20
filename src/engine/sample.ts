/**
 * A draft of a value a JSON Schema accepts, for a person to edit: every property of an object (so they see what can
 * be given), the first enum value or a schema's own example or default, empty strings and zeros otherwise, null where
 * the schema allows it and nothing better is known. A starting point, checked against the schema when it is used.
 */
type S = Record<string, unknown>;
const isObj = (v: unknown): v is S => !!v && typeof v === 'object' && !Array.isArray(v);

export function sampleOf(schema: unknown, depth = 0): unknown {
  if (!isObj(schema) || depth > 6) return null;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if ('default' in schema) return schema.default;
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = schema[key];
    if (Array.isArray(options) && options.length) {
      // The simplest way through: null when allowed.
      if (options.some((o) => isObj(o) && o.type === 'null')) return null;
      return sampleOf(options[0], depth + 1);
    }
  }
  const types = Array.isArray(schema.type) ? (schema.type as unknown[]) : schema.type ? [schema.type] : isObj(schema.properties) ? ['object'] : [];
  if (types.includes('null')) return null;
  const t = types[0];
  if (t === 'object') {
    const out: S = {};
    for (const [k, v] of Object.entries(isObj(schema.properties) ? schema.properties : {}).slice(0, 40)) out[k] = sampleOf(v, depth + 1);
    return out;
  }
  if (t === 'array') return [];
  if (t === 'string') return '';
  if (t === 'integer' || t === 'number') return typeof schema.minimum === 'number' ? schema.minimum : 0;
  if (t === 'boolean') return false;
  return null;
}

/** "found (object or null), count (integer, required)": the top-level fields of an object schema, for a hint. */
export function fieldsHint(schema: unknown): string[] {
  if (!isObj(schema) || !isObj(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]) : []);
  return Object.entries(schema.properties).slice(0, 20).map(([k, v]) => {
    const p = isObj(v) ? v : {};
    const type = Array.isArray(p.type) ? (p.type as unknown[]).join(' or ') : typeof p.type === 'string' ? p.type : Array.isArray(p.enum) ? `one of ${(p.enum as unknown[]).slice(0, 6).map(String).join(', ')}` : 'any';
    return `${k} (${type}${required.has(k) ? ', required' : ''})`;
  });
}
