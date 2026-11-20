import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The site's guides (site/docs.html) are short rewrites of docs/. Each ends with "Full reference", a link to the doc
 * (and section) it summarizes: when a doc is renamed or a section heading changes, this fails, so the guide is
 * looked at again.
 */
const root = path.resolve(import.meta.dirname, '..');
const DOCS = 'https://github.com/SudoDevStudio/dittoly/blob/main/docs/';

/** GitHub's anchor for a Markdown heading. */
const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-');

describe('site guides', () => {
  const html = readFileSync(path.join(root, 'site', 'docs.html'), 'utf8');
  const index = readFileSync(path.join(root, 'site', 'index.html'), 'utf8');

  it('every link into docs/ names a doc and a section that exist', () => {
    const links = [...`${html}\n${index}`.matchAll(new RegExp(`href="${DOCS.replace(/[.]/g, '\\.')}([^"#]+)(?:#([^"]+))?"`, 'g'))];
    expect(links.length).toBeGreaterThan(15);
    for (const [, file, anchor] of links) {
      const doc = path.join(root, 'docs', file!);
      expect(existsSync(doc), file).toBe(true);
      if (!anchor) continue;
      const headings = readFileSync(doc, 'utf8').split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+/, '')));
      expect(headings, `${file}#${anchor}`).toContain(anchor);
    }
  });

  it('every guide the home page lists is on the guides page', () => {
    const ids = new Set([...html.matchAll(/<article class="guide" id="([^"]+)"/g)].map((m) => m[1]));
    const listed = [...index.matchAll(/href="docs\.html#([^"]+)"/g)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(15);
    for (const id of listed) expect(ids.has(id), id).toBe(true);
  });
});
