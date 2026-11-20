import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compareModels } from '../src/ai/compare-models.js';
import { parseFlowDefinition } from '../src/flows/definition.js';
import { flowFindings, flowQuality } from '../src/flows/service.js';
import { draftQuality } from '../src/modules/validate.js';
import type { ValidationReport } from '../src/modules/validate.js';
import { makeWorld, type World } from './helpers.js';

/**
 * A draft is worth what its checks say about it, and that reading is kept with the version, shown to the approver,
 * handed back to the AI while it drafts, and added up per model. These tests hold all four to the same reading.
 */
let w: World;
const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');

beforeAll(async () => {
  w = await makeWorld();
});
afterAll(async () => {
  await w.db.end();
});

const report = (checks: { name: string; passed: boolean }[], tests: { name: string; passed: boolean }[] = []): ValidationReport =>
  ({ passed: checks.every((c) => c.passed), checks, tests } as unknown as ValidationReport);

describe('what a module draft is worth', () => {
  it('counts security and performance findings apart, and its tests', () => {
    const q = draftQuality(
      report(
        [
          { name: 'OWASP A04: Cryptographic Failures (weak randomness)', passed: false },
          { name: 'OWASP A01: Broken Access Control', passed: true },
          { name: 'Performance P1: one call at a time in a loop', passed: false },
          { name: 'settings explained (help and example)', passed: false },
        ],
        [{ name: 'posts', passed: true }, { name: 'refuses nonsense', passed: false }],
      ),
    );
    expect(q).toMatchObject({
      security: ['OWASP A04: Cryptographic Failures (weak randomness)'],
      performance: ['Performance P1: one call at a time in a loop'],
      explained: false,
      tests: { total: 2, passed: 1 },
      clean: false,
    });
  });

  it('is clean only when nothing was found and its tests pass', () => {
    const q = draftQuality(report([{ name: 'OWASP A05: Injection', passed: true }], [{ name: 'posts', passed: true }]));
    expect(q?.clean).toBe(true);
    // A module nobody wrote a test for is not clean, however quiet the checks are.
    expect(draftQuality(report([{ name: 'OWASP A05: Injection', passed: true }]))?.clean).toBe(false);
    expect(draftQuality(null)).toBe(null);
  });

  it('comes back with the module review', async () => {
    const mv = await w.app.modules.createDraft(
      {
        manifest: JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')),
        code: await readFile(path.join(dir, 'module.mjs'), 'utf8'),
        tests: JSON.parse(await readFile(path.join(dir, 'tests.json'), 'utf8')),
        origin: 'seed',
        generation: { source: null, reference: null, instructions: null, by: { provider: 'mock', model: 'mock-1', effort: 'medium' }, cost: { input: 100, output: 50, calls: 2 } },
      },
      w.alice,
    );
    const review = await w.app.modules.review(mv.id);
    expect(review.quality).not.toBe(null);
    expect(review.quality?.tests.total).toBeGreaterThan(0);
  });
});

const parse = (steps: unknown[]) => {
  const out = parseFlowDefinition({ inputs: { type: 'object', properties: { text: { type: 'string' } } }, steps });
  if (!out.ok) throw new Error(out.issues.join('; '));
  return out.definition;
};

describe('what a Flow draft is worth', () => {
  it('says a Flow that changes something with nobody signing off, and nothing remembered', () => {
    const def = parse([{ id: 'put', type: 'table', table: 'handled', op: 'put', key: '{{ inputs.text }}', values: { text: '{{ inputs.text }}' } }]);
    const q = flowQuality(def, new Map());
    expect(q.writes).toBe(1);
    expect(q.signOffBeforeWrite).toBe(false);
    expect(q.remembers).toBe(false);
    expect(q.clean).toBe(false);
    const found = flowFindings(q);
    expect(found.join(' ')).toContain('before anybody signs off');
    expect(found.join(' ')).toContain('does not remember');
  });

  it('is satisfied by a sign-off, a condition, a table it reads first and examples that pass', () => {
    const def = parse([
      { id: 'look', type: 'table', table: 'handled', op: 'get', key: '{{ inputs.text }}' },
      { id: 'ok', type: 'approval' },
      { id: 'put', type: 'table', table: 'handled', op: 'put', key: '{{ inputs.text }}', values: { text: '{{ inputs.text }}' }, when: { isTrue: 'steps.look.output.found' } },
    ]);
    const q = flowQuality(def, new Map(), { examples: { total: 2, passed: 2 } });
    expect(q).toMatchObject({ signOffBeforeWrite: true, conditionOnWrite: true, remembers: true, clean: true });
    expect(flowFindings(q)).toEqual([]);
  });

  it('counts a step reachable by model-written text as something to answer', () => {
    const def = parse([{ id: 'look', type: 'table', table: 'handled', op: 'get', key: '{{ inputs.text }}' }]);
    const q = flowQuality(def, new Map(), { unacceptedInjection: 2, examples: { total: 1, passed: 1 } });
    expect(q.clean).toBe(false);
    expect(flowFindings(q).join(' ')).toContain('2 step(s)');
  });
});

describe('comparing the models', () => {
  it('adds every draft up under the exact model that wrote it', async () => {
    const { rows } = await compareModels(w.db);
    const mock = rows.find((r) => r.label === 'mock:mock-1:medium');
    expect(mock, rows.map((r) => r.label).join(', ')).toBeTruthy();
    expect(mock!.modules.drafted).toBe(1);
    // Two calls for one draft: it was sent back to be fixed once.
    expect(mock!.cost).toMatchObject({ drafts: 1, input: 100, output: 50, calls: 2 });
  });
});
