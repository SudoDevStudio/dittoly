import { describe, expect, it } from 'vitest';
import { re2Pattern, tidyManifest } from '../src/modules/manifest-tidy.js';
import { validateModule } from '../src/modules/validate.js';
import { ProcessRunner } from '../src/sandbox/runner.js';

/**
 * Every `pattern` runs on RE2. Models write JavaScript's A; RE2 reads \x{0041}. A drafted module once lost
 * every draft over it: saving crashed with "unexpected error" instead of telling the AI what to fix.
 */
const manifest = (pattern: string) => ({
  name: 'gh-check', version: '1.0.0', title: 'Check', description: 'Checks a body.', hosts: [], credentials: [],
  actions: [{ name: 'post', title: 'Post', description: 'Posts a body.', effect: 'read', credentials: [],
    input: { type: 'object', properties: { body: { type: 'string', pattern } }, required: ['body'], additionalProperties: false },
    output: { type: 'object' } }],
});
const code = `export const actions = { async post(input) { return { ok: true }; } };`;
const tests = [{ name: 'posts', action: 'post', input: { body: 'hello' }, expectOk: true }];

describe('patterns in a drafted module', () => {
  it('JavaScript code-point escapes become RE2 ones; an escaped backslash stays', () => {
    expect(re2Pattern('^[^\\u0000-\\u001F]+$')).toBe('^[^\\x{0000}-\\x{001F}]+$');
    expect(re2Pattern('\\u0041\\u0042')).toBe('\\x{0041}\\x{0042}');
    expect(re2Pattern('\\u{1F600}')).toBe('\\x{1F600}');
    expect(re2Pattern('\\\\u0041')).toBe('\\\\u0041');
    const tidy = tidyManifest(manifest('^[^\\u0000-\\u001F]+$')) as ReturnType<typeof manifest>;
    expect(tidy.actions[0]!.input.properties.body.pattern).toBe('^[^\\x{0000}-\\x{001F}]+$');
  });

  it('a tidied pattern passes the checks and its tests run', async () => {
    const { report } = await validateModule(new ProcessRunner(), tidyManifest(manifest('^[^\\u0000-\\u001F]+$')), code, tests as never);
    expect(report.passed, JSON.stringify(report)).toBe(true);
  });

  it('a pattern RE2 cannot read fails a check with the reason, and never stops the checks', async () => {
    const { report } = await validateModule(new ProcessRunner(), manifest('^(?=.*a).+$'), code, tests as never);
    expect(report.passed).toBe(false);
    const check = report.checks.find((c) => c.name === 'action input/output schemas compile')!;
    expect(check.passed).toBe(false);
    expect(String(check.details)).toMatch(/actions\.post\.input: not a valid JSON Schema .*RE2: no lookahead/);
    expect(report.tests).toEqual([expect.objectContaining({ name: 'posts', passed: false })]);
  });
});
