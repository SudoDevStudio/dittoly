import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The portal is themed through tokens: a colour taken from a variable that nothing defines silently falls back to
 * whatever is written beside it, which is how a dark bubble ended up behind dark text in day mode. These checks
 * read the stylesheet itself, so that mistake cannot come back.
 */
const css = readFileSync(path.resolve(import.meta.dirname, '..', 'web', 'src', 'styles.css'), 'utf8');
/** Variables the browser provides, not the theme. */
const BUILT_IN = /^--(swiper|vh)/;

describe('the portal stylesheet', () => {
  it('uses no colour variable that nothing defines', () => {
    const defined = new Set([...css.matchAll(/(^|[;{]\s*)(--[a-z0-9-]+)\s*:/gim)].map((m) => m[2]!));
    const used = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]!));
    const missing = [...used].filter((v) => !defined.has(v) && !BUILT_IN.test(v));
    expect(missing, `defined nowhere: ${missing.join(', ')}`).toEqual([]);
  });

  it('gives every token a value in both themes', () => {
    const block = (selector: string) => {
      const at = css.indexOf(selector);
      expect(at, selector).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf('}', at));
    };
    const names = (text: string) => new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    const dark = names(block(':root {'));
    const light = names(block(":root[data-theme='light'] {"));
    // A token the day theme does not redefine keeps the night value, which is how unreadable pages happen.
    const colour = (v: string) => /(bg|surface|text|border|accent|ok|warn|bad|info|code)/.test(v);
    const onlyDark = [...dark].filter((v) => colour(v) && !light.has(v));
    expect(onlyDark, `night only: ${onlyDark.join(', ')}`).toEqual([]);
  });

});
