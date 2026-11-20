import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.js';
import { resetMediaCache } from '../src/core/media.js';
import { detectMedia, hostAllowed } from '../web/src/media.js';
import { makeWorld, type World } from './helpers.js';

describe('which links are media', () => {
  const allowed = ['cdn.acme.test', '*.s3.amazonaws.com'];
  it('plays YouTube through its privacy-enhanced domain, with the start time', () => {
    expect(detectMedia('https://www.youtube.com/watch?v=dQw4w9WgXcQ', [])).toEqual({ kind: 'youtube', src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', title: 'YouTube video' });
    expect(detectMedia('https://youtu.be/dQw4w9WgXcQ?t=1m30s', [])!.src).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=90');
    expect(detectMedia('https://m.youtube.com/shorts/dQw4w9WgXcQ', [])!.kind).toBe('youtube');
    expect(detectMedia('https://www.youtube.com/watch?v=not-an-id', [])).toBeNull();
    expect(detectMedia('https://youtube.com/channel/abc', [])).toBeNull();
    expect(detectMedia('https://vimeo.com/76979871', [])).toMatchObject({ kind: 'vimeo', src: 'https://player.vimeo.com/video/76979871' });
  });
  it('shows pages on browser modules\' sites live, on the declared scheme only', () => {
    const pages = ['https://shop.example.com', 'https://*.status.example.com', 'http://127.0.0.1:3000'];
    expect(detectMedia('https://shop.example.com/cart', [], pages)).toEqual({ kind: 'live', src: 'https://shop.example.com/cart', title: 'shop.example.com' });
    expect(detectMedia('https://eu.status.example.com/', [], pages)!.kind).toBe('live');
    expect(detectMedia('http://127.0.0.1:3000/cart', [], pages)!.kind).toBe('live');
    expect(detectMedia('http://shop.example.com/cart', [], pages)).toBeNull();
    expect(detectMedia('https://127.0.0.1:3000/', [], pages)).toBeNull();
    expect(detectMedia('https://evil.example.com/', [], pages)).toBeNull();
    expect(detectMedia('https://user:pw@shop.example.com/', [], pages)).toBeNull();
  });

  it('shows files, images, PDFs and pages only from allowed hosts, over https', () => {
    expect(detectMedia('https://cdn.acme.test/films/trailer.mp4', allowed)).toMatchObject({ kind: 'video', title: 'trailer.mp4' });
    expect(detectMedia('https://cdn.acme.test/a/song.mp3', allowed)!.kind).toBe('audio');
    expect(detectMedia('https://bucket.s3.amazonaws.com/p.png', allowed)!.kind).toBe('image');
    expect(detectMedia('https://cdn.acme.test/report.pdf', allowed)!.kind).toBe('pdf');
    expect(detectMedia('https://cdn.acme.test/status', allowed)!.kind).toBe('page');
    expect(detectMedia('https://evil.test/trailer.mp4', allowed)).toBeNull();
    expect(detectMedia('http://cdn.acme.test/trailer.mp4', allowed)).toBeNull();
    expect(detectMedia('https://user:pw@cdn.acme.test/x.mp4', allowed)).toBeNull();
    expect(hostAllowed('s3.amazonaws.com', allowed)).toBe(false); // *. needs a label in front
    expect(hostAllowed('evilcdn.acme.test', allowed)).toBe(false);
  });
});

describe('allowed media hosts and the security policy', () => {
  let w: World;
  let api: ReturnType<typeof buildServer>;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  beforeAll(async () => {
    resetMediaCache();
    w = await makeWorld();
    api = buildServer(w.app);
  });
  afterAll(async () => {
    resetMediaCache();
    await api.close();
    await w.db.end();
  });

  it('players are always allowed; admins add hosts, which the CSP then allows for media only', async () => {
    const csp = () => api.inject({ method: 'GET', url: '/health' }).then((r) => String(r.headers['content-security-policy']));
    expect(await csp()).toContain("frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com;");
    expect(await csp()).toContain("img-src 'self' data:;");

    expect((await api.inject({ method: 'PUT', url: '/api/settings/media', headers: auth(w.tokens.alice), payload: { hosts: ['cdn.acme.test'] } })).json()).toEqual({ error: 'admin_only' });
    const injected = await api.inject({ method: 'PUT', url: '/api/settings/media', headers: auth(w.tokens.admin), payload: { hosts: ["cdn.acme.test; script-src 'unsafe-inline'"] } });
    expect(injected.json()).toMatchObject({ error: 'invalid_media_hosts' });

    const ok = await api.inject({ method: 'PUT', url: '/api/settings/media', headers: auth(w.tokens.admin), payload: { hosts: ['https://CDN.acme.test/', '*.s3.amazonaws.com'] } });
    expect(ok.json()).toEqual({ hosts: ['cdn.acme.test', '*.s3.amazonaws.com'] });
    const policy = await csp();
    expect(policy).toContain("img-src 'self' data: https://cdn.acme.test https://*.s3.amazonaws.com;");
    expect(policy).toContain("media-src 'self' https://cdn.acme.test https://*.s3.amazonaws.com;");
    expect(policy).toContain("frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com https://cdn.acme.test https://*.s3.amazonaws.com;");
    expect(policy).toContain("script-src 'self';");
    expect((await api.inject({ method: 'GET', url: '/api/settings/media', headers: auth(w.tokens.bob) })).json()).toEqual({ hosts: ['cdn.acme.test', '*.s3.amazonaws.com'], players: ['youtube', 'vimeo'], pages: [] });
  });
});
