import { describe, expect, it } from 'vitest';
import { generateModule } from '../src/ai/generate-module.js';
import { MockProvider } from '../src/ai/provider.js';

describe('module generation diagnostics', () => {
  it.each(['manifestJson', 'testsJson'] as const)('names the malformed field, and keeps what the AI answered so a person can see why', async (field) => {
    const ai = new MockProvider();
    ai.enqueue({ manifestJson: '{}', code: 'export const actions = {};', testsJson: '[]', [field]: '{"half-written":' });
    const error = (await generateModule(ai, 'Build a module.').catch((err: unknown) => err)) as { code: string; detail: string; raw: string };
    expect(error.code).toBe('ai_response_not_json');
    // The message says which field broke; the answer itself comes with it, as it was written.
    expect(error.detail).toContain(field);
    expect(error.detail).not.toContain('half-written');
    expect(error.raw).toBe('{"half-written":');
  });

  it('keeps only an excerpt of a very long answer, saying how much was left out', async () => {
    const ai = new MockProvider();
    ai.enqueue({ manifestJson: `{"actions": "${'x'.repeat(9000)}`, code: 'export const actions = {};', testsJson: '[]' });
    const error = (await generateModule(ai, 'Build a module.').catch((err: unknown) => err)) as { raw: string };
    expect(error.raw.length).toBeLessThan(4200);
    expect(error.raw).toMatch(/characters left out/);
    expect(error.raw.startsWith('{"actions": "xxx')).toBe(true);
  });
});
