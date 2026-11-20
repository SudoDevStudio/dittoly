import { describe, expect, it } from 'vitest';
import { parseManifest, type Manifest } from '../src/modules/manifest.js';
import { Broker, type FetchLike } from '../src/sandbox/broker.js';
import { ProcessRunner } from '../src/sandbox/runner.js';

/** Modules upload files (screenshots) as multipart forms; the broker builds the form, the module never sees a secret. */
const manifest = (parseManifest({
  name: 'uploader',
  version: '1.0.0',
  title: 'Uploader',
  description: 'Uploads a screenshot.',
  hosts: ['files.example.com'],
  credentials: [{ id: 'tok', service: 'files', label: 'Files token', hosts: ['files.example.com'], placement: { type: 'bearer' } }],
  actions: [{ name: 'upload', title: 'Upload', description: 'Uploads.', effect: 'write', credentials: ['tok'], input: {}, output: {} }],
}) as { manifest: Manifest }).manifest;

describe('multipart uploads', () => {
  it('a data URL from the module arrives as a file part, with the credential attached by the broker', async () => {
    let seen: { type: string | null; auth: string | null; body: string } | null = null;
    const fetchImpl: FetchLike = async (_url, init) => {
      const h = new Headers(init.headers);
      seen = { type: h.get('content-type'), auth: h.get('authorization'), body: Buffer.from(init.body as Uint8Array).toString('latin1') };
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const broker = new Broker({ manifest, action: 'upload', resolveSecret: async () => 'secret-token', fetchImpl });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64');
    const code = `export const actions = { async upload(input, ctx) {
      const res = await ctx.http.request({ method: 'POST', url: 'https://files.example.com/up', credential: 'tok',
        multipart: [{ name: 'comment', value: 'hello' }, { name: 'file', filename: 'shot 1.png', dataUrl: input.shot }] });
      return { status: res.status };
    } };`;
    const r = await new ProcessRunner().invoke({ code, action: 'upload', input: { shot: `data:image/png;base64,${png}` }, broker });
    expect(r).toMatchObject({ ok: true, output: { status: 200 } });
    expect(seen!.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen!.auth).toBe('Bearer secret-token');
    expect(seen!.body).toContain('name="comment"\r\n\r\nhello');
    expect(seen!.body).toContain('filename="shot_1.png"\r\nContent-Type: image/png');
    expect(seen!.body).toContain(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('latin1'));
  }, 30_000);

  it('refuses malformed or oversized forms, and forms on GET', async () => {
    const fetchImpl: FetchLike = async () => new Response('{}');
    const b = new Broker({ manifest, action: 'upload', resolveSecret: async () => null, fetchImpl });
    const req = { method: 'POST', url: 'https://files.example.com/up', headers: {}, credential: null, body: null, json: false };
    expect(await b.handle({ ...req, multipart: [{ name: 'f', data: 'not base64!' }] })).toMatchObject({ ok: false, error: 'request_too_large' });
    expect(await b.handle({ ...req, multipart: [{ name: 'f', filename: 'x', data: 'A'.repeat(14_000_000) }] })).toMatchObject({ ok: false, error: 'request_too_large' });
    expect(await b.handle({ ...req, method: 'GET', multipart: [{ name: 'f', value: 'x' }] })).toMatchObject({ ok: false, error: 'egress_denied_method' });
  });
});
