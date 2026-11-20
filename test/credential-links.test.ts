import { describe, expect, it } from 'vitest';
import { addAt } from '../web/src/credential-links.js';

/**
 * "Missing before it can run: github." told a person what was wrong and left them to find the page that takes
 * it. Each missing credential is now a link to the page that stores that kind, with the app already filled in —
 * and a teammate's own account, which nobody else can add, is not a link at all.
 */
describe('where a missing credential is added', () => {
  it('sends you to your own vault, with the app filled in', () => {
    expect(addAt('github', 'yours')).toBe('/credentials?add=github');
  });

  it('sends you to the team page for a shared account', () => {
    expect(addAt('github', 'team')).toBe('/teams?credential=github');
  });

  it("offers no link for a teammate's own account: it is not ours to add", () => {
    expect(addAt('github', 'teammate')).toBeNull();
  });

  it('keeps an odd service name safe in the link', () => {
    expect(addAt('my app/one', 'yours')).toBe('/credentials?add=my%20app%2Fone');
  });
});
