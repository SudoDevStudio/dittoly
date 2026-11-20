import { describe, expect, it } from 'vitest';
import { fieldsHint, sampleOf } from '../src/engine/sample.js';
import { ajv } from '../src/modules/manifest.js';

/** The draft a person edits when they type in a failed step's result: it shows every field and fits the schema. */
describe('a draft from a JSON Schema', () => {
  const schema = {
    type: 'object',
    properties: {
      found: { type: ['object', 'null'], properties: { number: { type: 'integer' } } },
      count: { type: 'integer', minimum: 1 },
      state: { enum: ['open', 'merged'] },
      items: { type: 'array', items: { type: 'string' } },
      note: { type: 'string' },
      pr: { anyOf: [{ type: 'null' }, { type: 'object', properties: { url: { type: 'string' } } }] },
    },
    required: ['found', 'count'],
  };

  it('has every property, null where allowed, the first choice of an enum, and fits the schema', () => {
    const s = sampleOf(schema);
    expect(s).toEqual({ found: null, count: 1, state: 'open', items: [], note: '', pr: null });
    expect(ajv.validate(schema, s)).toBe(true);
  });

  it('names the fields with their types', () => {
    expect(fieldsHint(schema)).toEqual(['found (object or null, required)', 'count (integer, required)', 'state (one of open, merged)', 'items (array)', 'note (string)', 'pr (any)']);
  });

  it('is null for no schema, and uses a schema\'s own example or default', () => {
    expect(sampleOf(undefined)).toBeNull();
    expect(sampleOf({ type: 'string', examples: ['acme/shop'] })).toBe('acme/shop');
    expect(sampleOf({ type: 'integer', default: 30 })).toBe(30);
  });
});
