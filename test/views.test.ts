import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { DEFAULT_VIEWS, withDeadline } from '../src/views/views.js';
import { makeWorld, type World } from './helpers.js';

const ai = new MockProvider();
let w: World;
beforeAll(async () => {
  w = await makeWorld({}, { ai });
});
afterAll(async () => w.db.end());

describe('custom views', () => {
  it('a chat request becomes a validated, per-member display configuration', async () => {
    ai.enqueue({ configJson: JSON.stringify({ hideModules: ['gitlab'], hideStatuses: ['skipped'], showOutputs: true, compact: true }), reply: 'Hidden.' });
    const r = await w.app.views.chat(w.alice, 'run', 'hide merge requests and skipped steps, compact');
    expect(r.config).toEqual({ hideModules: ['gitlab'], hideStatuses: ['skipped'], showOutputs: true, compact: true });
    expect(await w.app.views.get(w.alice, 'run')).toEqual(r.config);
    expect(await w.app.views.get(w.bob, 'run')).toEqual(DEFAULT_VIEWS.run); // other members unaffected
    expect(ai.requests.at(-1)!.prompt).toContain('Current configuration');
  });

  it('rejects anything outside the trusted components and options, and keeps the old view', async () => {
    const before = await w.app.views.get(w.alice, 'run');
    for (const bad of [
      { hideModules: ['<script>'], hideStatuses: [], showOutputs: true, compact: false },
      { hideModules: [], hideStatuses: [], showOutputs: true, compact: false, html: '<img onerror=alert(1)>' },
      { hideModules: [], hideStatuses: ['failed'], showOutputs: true, compact: false }, // failures can never be hidden
    ]) {
      ai.enqueue({ configJson: JSON.stringify(bad), reply: 'ok' });
      await expect(w.app.views.chat(w.alice, 'run', 'x')).rejects.toMatchObject({ code: 'invalid_view' });
    }
    ai.enqueue({ configJson: JSON.stringify({ widgets: [{ id: 'evil_widget', visible: true }] }), reply: 'ok' });
    await expect(w.app.views.chat(w.alice, 'home', 'x')).rejects.toMatchObject({ code: 'invalid_view' });
    expect(await w.app.views.get(w.alice, 'run')).toEqual(before);
  });

  it('a request about the Flow, not the screen, changes nothing and says where to do it', async () => {
    const before = await w.app.views.get(w.alice, 'run');
    ai.enqueue({ configJson: JSON.stringify(before), reply: 'This box only changes what you see; ask in the home chat to make the Flow post the comment.', notLayout: true });
    const r = await w.app.views.chat(w.alice, 'run', 'it is not posting the comment on the PR that is needed');
    expect(r).toEqual({ config: before, reply: 'This box only changes what you see; ask in the home chat to make the Flow post the comment.', notLayout: true });
    expect(await w.app.views.get(w.alice, 'run')).toEqual(before);
    expect(ai.requests.at(-1)!.system).toContain('notLayout true');
  });

  it('an AI that does not answer in time ends with a plain error instead of a spinning button', async () => {
    const never = new Promise<string>(() => undefined);
    await expect(withDeadline(never, 20)).rejects.toMatchObject({ code: 'ai_timeout', httpStatus: 504, message: expect.stringContaining('Nothing was changed') });
    await expect(withDeadline(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });

  it('unknown screens are refused; reset returns the default', async () => {
    await expect(w.app.views.get(w.alice, 'flows')).rejects.toMatchObject({ code: 'unknown_view' });
    expect(await w.app.views.reset(w.alice, 'run')).toEqual(DEFAULT_VIEWS.run);
  });
});
