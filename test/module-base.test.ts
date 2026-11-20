import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { looseJson } from '../src/runtime/ai.js';
import { MockProvider } from '../src/ai/provider.js';
import { moduleGuide } from '../src/core/guides.js';
import { BASE_SOURCE, hasBase, kindsUsed, ownCode, withBase } from '../src/modules/module-base.js';
import { checkModuleConfig } from '../src/modules/module-config.js';
import { makeWorld, type World } from './helpers.js';

/**
 * Every module is the Dittoly base, then its own TypeScript that calls it (and replaces any part of it where it
 * needs to). The AI also writes a config that says what each action is and does, for people and the next AI: it is
 * checked against the manifest and the code, but it never runs anything.
 */
const ai = new MockProvider();
let w: World;
beforeAll(async () => {
  w = await makeWorld({}, { ai });
});
afterAll(async () => {
  await w.db.end();
});

const dir = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');
const fixture = (name: string) => readFile(path.join(import.meta.dirname, 'fixtures', name), 'utf8');
const slackConfig = {
  baseUrl: 'https://slack.com/api',
  actions: {
    post_message: { kind: 'http', call: 'POST /chat.postMessage' },
    delete_message: { kind: 'http', call: 'POST /chat.delete', custom: 'maps message_not_found to not_found' },
  },
};
const slackAnswer = async (config: unknown = slackConfig) => ({
  manifestJson: await readFile(path.join(dir, 'manifest.json'), 'utf8'),
  configJson: JSON.stringify(config),
  code: await fixture('slack-on-base.ts.txt'),
  testsJson: await readFile(path.join(dir, 'tests.json'), 'utf8'),
  sourcesJson: '[]',
  notesMd: '',
});

describe('modules on the Dittoly base', () => {
  it('the base goes on top once, and the module\'s own code is what is left', async () => {
    const own = await fixture('slack-on-base.ts.txt');
    const full = withBase(own);
    expect(hasBase(full)).toBe(true);
    expect(full.startsWith(BASE_SOURCE)).toBe(true);
    expect(withBase(full)).toBe(full);
    expect(ownCode(full)).toBe(own.trimStart());
    expect(kindsUsed(full)).toEqual(['http']);
    expect(kindsUsed(withBase(await fixture('shop-on-base.ts.txt')))).toEqual(['db', 'smtp', 'mqtt']);
  });

  it('the module skill and docs/module-types.md say what every kind can do, by its base call', async () => {
    const skill = await readFile(path.join(import.meta.dirname, '..', 'skills', 'module-authoring', 'SKILL.md'), 'utf8');
    const docs = await readFile(path.join(import.meta.dirname, '..', 'docs', 'module-types.md'), 'utf8');
    for (const name of ['base.http.client', 'base.db.first', 'base.mail.send', 'base.amqp.publish', 'base.mqtt.publish', 'base.ws.exchange', 'base.sse.read']) {
      expect(skill, name).toContain(name);
      expect(docs, name).toContain(name);
      expect(BASE_SOURCE, name).toContain(name.split('.').at(-1)!);
    }
  });

  it('a drafted module is the base plus the AI\'s code, passes its tests, keeps its config, and is revised as its own code', async () => {
    ai.enqueue(await slackAnswer());
    const out = await w.app.moduleChat.generate('Post messages to Slack and delete them', w.alice);
    const draft = (out as { draft: { id: string; source: string; validationReport: { passed: boolean } } }).draft;
    expect(draft.validationReport.passed, JSON.stringify(draft.validationReport)).toBe(true);
    expect(hasBase(draft.source)).toBe(true);
    const review = await w.app.modules.review(draft.id);
    expect(review.config).toMatchObject({ actions: { post_message: { kind: 'http' } } });
    expect(review.ownSource).not.toContain('function baseFill');
    expect(review.ownSource).toContain('slack.post(ctx');
    expect(review.guide).toContain('- Does: http: POST /chat.delete. maps message_not_found to not_found');
    expect(review.guide).toContain('## What its kinds can do\n- http (base.http.client');

    // A revision shows the AI its own code and config, not the base.
    ai.enqueue(await slackAnswer());
    await w.app.moduleChat.revise(draft.id, 'Name the error codes better.', w.alice);
    const prompt = ai.requests.at(-1)!.prompt;
    expect(prompt).toContain('Code (its own part, under the Dittoly base):\n/** Slack');
    expect(prompt).toMatch(/Config:\n\{.*"baseUrl":"https:\/\/slack\.com\/api"/);
    expect(prompt).not.toContain('function baseFill');
  });

  it('a config that does not say what the module does goes back once; a module is never lost over it', async () => {
    const wrong = { actions: { post_message: { kind: 'http', call: 'POST /chat.postMessage' } } };
    ai.enqueue(await slackAnswer(wrong));
    ai.enqueue(await slackAnswer(wrong));
    const out = await w.app.moduleChat.generate('Post messages to Slack and delete them', w.alice);
    expect(ai.requests.at(-1)!.prompt).toContain('does not describe the module correctly: actions.delete_message: the manifest declares it but the config does not describe it');
    const draft = (out as { draft: { id: string; validationReport: { passed: boolean } } }).draft;
    expect(draft.validationReport.passed).toBe(true);
    expect((await w.app.modules.review(draft.id)).config).toBeNull();
  });

  it('an unreadable answer while fixing only the config keeps the module, without a config', async () => {
    const wrong = { actions: { post_message: { kind: 'http', call: 'POST /chat.postMessage' } } };
    ai.enqueue(await slackAnswer(wrong));
    // Both tries at fixing the config come back unreadable.
    ai.enqueue({ ...(await slackAnswer()), manifestJson: '{"name": ' });
    ai.enqueue({ ...(await slackAnswer()), manifestJson: '{"name": ' });
    const out = await w.app.moduleChat.generate('Post messages to Slack and delete them, again', w.alice);
    const draft = (out as { draft: { id: string; validationReport: { passed: boolean } } }).draft;
    expect(draft.validationReport.passed).toBe(true);
    expect((await w.app.modules.review(draft.id)).config).toBeNull();
    expect(ai.clear()).toBe(0);
  });

  it('reads JSON fields with the slips models make: a fence, a comma before a bracket', () => {
    expect(looseJson('```json\n{"a": [1, 2,], "b": "x,]"}\n```')).toEqual({ a: [1, 2], b: 'x,]' });
    expect(looseJson('{"a": "say \\"hi\\",}", }')).toEqual({ a: 'say "hi",}' });
    expect(() => looseJson('{"a": ')).toThrow();
  });

  it('database, email and MQTT actions use the base too; the config is checked against the manifest and the code', async () => {
    const obj = (props: Record<string, unknown>, required: string[]) => ({ type: 'object', properties: props, required, additionalProperties: false });
    const manifest = {
      name: 'shop-ops', version: '1.0.0', title: 'Shop operations', description: 'Orders in the shop database, mail to customers, commands to the packing line.',
      hosts: [],
      settings: [
        { id: 'db_host', type: 'host', label: 'Database server', pattern: '*.example.com', default: 'db.example.com', help: 'The database server.', example: 'db.example.com' },
        { id: 'smtp_host', type: 'host', label: 'Mail server', pattern: '*.example.com', default: 'smtp.example.com', help: 'The mail server.', example: 'smtp.example.com' },
        { id: 'broker', type: 'host', label: 'MQTT broker', pattern: '*.example.com', default: 'mqtt.example.com', help: 'The broker.', example: 'mqtt.example.com' },
      ],
      credentials: [
        { id: 'db_login', service: 'shop-db', label: 'Database login', hosts: ['{{settings.db_host}}'], placement: { type: 'basic' } },
        { id: 'smtp_login', service: 'shop-mail', label: 'Mail login', hosts: ['{{settings.smtp_host}}'], placement: { type: 'basic' } },
      ],
      endpoints: [
        { id: 'shop', protocol: 'postgres', host: '{{settings.db_host}}', database: 'shop', credential: 'db_login', queries: [
          { id: 'find_order', effect: 'read', sql: 'SELECT id, status, email FROM orders WHERE id = :order_id', params: { order_id: { type: 'integer' } }, maxRows: 1 },
          { id: 'ship', effect: 'write', sql: "UPDATE orders SET status = 'shipped' WHERE id = :order_id", params: { order_id: { type: 'integer' } } },
        ] },
        { id: 'mail', protocol: 'smtp', host: '{{settings.smtp_host}}', credential: 'smtp_login', from: 'shop@example.com' },
        { id: 'line', protocol: 'mqtt', host: '{{settings.broker}}', topics: ['packing/+/commands'] },
      ],
      actions: [
        { name: 'get_order', title: 'Get order', description: 'Finds an order.', effect: 'read', credentials: ['db_login'], input: obj({ id: { type: 'integer', minimum: 1 } }, ['id']), output: { type: 'object' } },
        { name: 'ship_order', title: 'Ship order', description: 'Marks an order shipped.', effect: 'write', credentials: ['db_login'], input: obj({ id: { type: 'integer', minimum: 1 } }, ['id']), output: { type: 'object' } },
        { name: 'mail_customer', title: 'Mail customer', description: 'Sends an email.', effect: 'write', credentials: ['smtp_login'], input: obj({ to: { type: 'string', format: 'email' }, subject: { type: 'string', maxLength: 200, pattern: '^[^\\r\\n]*$' }, body: { type: 'string', maxLength: 5000 } }, ['to', 'subject', 'body']), output: { type: 'object' } },
        { name: 'pack', title: 'Pack', description: 'Tells a packing station to pack an order.', effect: 'write', credentials: [], input: obj({ station: { type: 'string', pattern: '^[a-z0-9/-]{1,20}$' }, id: { type: 'integer' } }, ['station', 'id']), output: { type: 'object' } },
      ],
    };
    const source = withBase(await fixture('shop-on-base.ts.txt'));
    const config = {
      actions: {
        get_order: { kind: 'db', call: 'query find_order', endpoint: 'shop', query: 'find_order' },
        ship_order: { kind: 'db', call: 'query ship', endpoint: 'shop', query: 'ship' },
        mail_customer: { kind: 'smtp', call: 'send an email', endpoint: 'mail' },
        pack: { kind: 'mqtt', call: 'publish to packing/{station}/commands', endpoint: 'line' },
      },
    };
    expect(checkModuleConfig(config, manifest, source)).toHaveProperty('config');
    const wrong = checkModuleConfig({ actions: { ...config.actions, get_order: { ...config.actions.get_order, query: 'ship' }, pack: { kind: 'amqp', call: 'publish', endpoint: 'line' } } }, manifest, source);
    expect('issues' in wrong && wrong.issues).toEqual([
      'actions.get_order.query: "ship" writes, but the action is a "read"',
      'actions.pack.endpoint: "line" is mqtt; a amqp action needs amqp',
      'actions.pack: the config says amqp, but the code makes no amqp call',
    ]);
    const tests = [
      { name: 'finds an order', action: 'get_order', input: { id: 7 }, calls: [{ protocol: 'postgres', query: 'find_order', rows: [{ id: 7, status: 'new', email: 'a@example.com' }] }] },
      { name: 'no such order', action: 'get_order', input: { id: 8 }, calls: [{ protocol: 'postgres', rows: [] }], expectOk: false },
      { name: 'ships', action: 'ship_order', input: { id: 7 }, calls: [{ protocol: 'postgres', query: 'ship', rowCount: 1 }] },
      { name: 'mails', action: 'mail_customer', input: { to: 'a@example.com', subject: 'Shipped', body: 'Your order is on its way.' } },
      { name: 'packs', action: 'pack', input: { station: 'line-1', id: 7 } },
      { name: 'refuses a station that leaves its topic level', action: 'pack', input: { station: 'a/b', id: 7 }, expectOk: false },
    ];
    const draft = await w.app.modules.createDraft({ manifest, source, tests, origin: 'seed' } as never, w.alice);
    expect(draft.validationReport!.passed, JSON.stringify(draft.validationReport)).toBe(true);
    const checked = checkModuleConfig(config, manifest);
    const guide = moduleGuide(manifest, { config: "config" in checked ? checked.config : null, source });
    expect(guide).toContain('- Does: db: query find_order on shop');
    expect(guide).toContain('- mqtt (base.mqtt.publish)');
  });
});
