import { describe, expect, it } from 'vitest';
import { tidyManifest } from '../src/modules/manifest-tidy.js';
import { parseManifest } from '../src/modules/manifest.js';

/** What models commonly get wrong in a manifest, and that has one obvious correction. */
const sloppy = {
  manifest: {
    name: 'GitHub PR Review',
    title: `GitHub inline review comment publication for pull requests ${'with duplicate suppression '.repeat(3)}`,
    description: `Posts inline review comments. ${'It checks for duplicates first. '.repeat(30)}`,
    hosts: ['https://API.github.com/'],
    settings: [],
    credentials: [{ id: 'github_token', service: 'GitHub', label: 'GitHub token', hosts: ['https://api.github.com'], placement: { type: 'header', name: 'Authorization', prefix: 'Bearer ' } }],
    actions: [
      { name: 'list_comments', effect: 'Read', idempotent: true, credentials: 'github_token', input: { type: 'object', properties: { repo: { type: 'string' } } }, output: { type: 'object' } },
      { name: 'post_comment', title: 'Post a comment', description: `Posts one inline comment. ${'x'.repeat(400)}`, effect: 'write', idempotent: true, credentials: ['github_token'], input: { type: 'object' } },
    ],
  },
};

describe('tidyManifest', () => {
  it('fixes the mechanical slips so the manifest parses', () => {
    expect(parseManifest(sloppy.manifest).ok).toBe(false);
    const tidy = tidyManifest(sloppy) as Record<string, any>;
    const parsed = parseManifest(tidy);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    expect(tidy.name).toBe('github-pr-review');
    expect(tidy.version).toBe('1.0.0');
    expect(tidy.title.length).toBeLessThanOrEqual(80);
    expect(tidy.description.length).toBe(500);
    expect(tidy.description.endsWith('…')).toBe(true);
    expect(tidy.hosts).toEqual(['api.github.com']);
    expect(tidy.credentials[0]).toMatchObject({ service: 'github', hosts: ['api.github.com'] });
    expect(tidy.actions[0]).toMatchObject({ effect: 'read', title: 'list comments', description: 'list comments', credentials: ['github_token'] });
    expect(tidy.actions[0].idempotent).toBeUndefined();
    expect(tidy.actions[1]).toMatchObject({ idempotent: true, output: { type: 'object' } });
    expect(tidy.actions[1].description.length).toBe(300);
  });

  it('never renames what the code refers to, and adds only the hosts a credential already names', () => {
    const m = { name: 'x-mod', version: '2.1.0', title: 'X', description: 'X', hosts: [], settings: [{ id: 'Site_Host', type: 'text', label: 'Site' }], credentials: [{ id: 'Key', service: 'x', label: 'Key', hosts: ['api.x.test'], placement: { type: 'header', name: 'x-key' } }], actions: [{ name: 'getThing', title: 'Get', description: 'Get', effect: 'read', credentials: ['Key'], input: {}, output: {} }] };
    const tidy = tidyManifest(m) as Record<string, any>;
    expect(tidy.settings[0].id).toBe('Site_Host');
    expect(tidy.credentials[0].id).toBe('Key');
    expect(tidy.actions[0].name).toBe('getThing');
    expect(tidy.version).toBe('2.1.0');
    expect(tidy.hosts).toEqual(['api.x.test']);
  });

  it('leaves what is not a manifest alone', () => {
    expect(tidyManifest('nope')).toBe('nope');
    expect(tidyManifest(null)).toBe(null);
  });
});
