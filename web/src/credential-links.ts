/**
 * Where a missing credential is added.
 *
 * "Missing before it can run: github." told a person what was wrong and left them to find the page that takes
 * it. Each one is a link to the page that stores that kind, with the app already filled in. A teammate's own
 * account is not ours to add: there is no link for it, and the text says whose it is instead.
 */
export const addAt = (service: string, whose: string): string | null =>
  whose === 'yours' ? `/credentials?add=${encodeURIComponent(service)}` : whose === 'team' ? `/teams?credential=${encodeURIComponent(service)}` : null;
