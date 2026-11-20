import { describe, expect, it } from 'vitest';
import { cliDetail } from '../src/ai/provider.js';

/**
 * When the AI command-line provider fails, "it failed" is not an answer: the CLI has already said why — not
 * signed in, out of credit, a model this account cannot use — and that line is what a person needs. It is kept
 * with the error, short, and with anything shaped like a key or a token taken out of it first.
 */
describe('what a failing CLI said', () => {
  it('keeps its own message, with the exit code', () => {
    const said = cliDetail({ code: 1, stdout: '', stderr: 'Error: credit balance is too low' });
    expect(said).toBe('the CLI exited with code 1: Error: credit balance is too low');
  });

  it('prefers what the CLI reported over whatever else it printed', () => {
    const said = cliDetail({ code: 0, stdout: '{"is_error":true}', stderr: 'warning: slow' }, 'Invalid API key · Please run /login');
    expect(said).toContain('Invalid API key');
    expect(said).not.toContain('slow');
  });

  it('never carries a key, a token or an authorization header out with it', () => {
    const said = cliDetail({
      code: 1,
      stdout: '',
      stderr: 'auth failed for sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ using Bearer eyJhbGciOi.JzdWIiOiIxMjM0NTY.Y3Bhc3M and ghp_AAAAAAAAAAAAAAAAAAAA (api_key=abcdef123456)',
    });
    expect(said).not.toContain('sk-ant-api03');
    expect(said).not.toContain('ghp_');
    expect(said).not.toContain('eyJhbGciOi');
    expect(said).not.toContain('abcdef123456');
    expect(said).toContain('[removed]');
  });

  it('keeps only the end of a long log, and says so when the CLI said nothing', () => {
    const said = cliDetail({ code: 2, stdout: '', stderr: `${'noise\n'.repeat(200)}the real reason` });
    expect(said).toContain('the real reason');
    expect(said.length).toBeLessThan(500);
    expect(cliDetail({ code: null, stdout: '', stderr: '' })).toBe('the CLI was stopped and said nothing');
  });
});
