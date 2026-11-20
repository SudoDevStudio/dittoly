import { describe, expect, it } from 'vitest';
import { validateModule } from '../src/modules/validate.js';
import { ajv } from '../src/modules/manifest.js';
import { ProcessRunner } from '../src/sandbox/runner.js';

const manifest = {
  name: 'jira',
  version: '1.0.0',
  title: 'Jira',
  description: 'Transitions.',
  hosts: ['acme.atlassian.net'],
  credentials: [{ id: 'jira', service: 'jira', label: 'Jira token', hosts: ['acme.atlassian.net'], placement: { type: 'basic' } }],
  actions: [
    {
      name: 'transition_issue',
      title: 'Transition issue',
      description: 'Moves an issue.',
      effect: 'write',
      credentials: ['jira'],
      input: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      output: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] },
    },
  ],
};
const code = `export const actions = {
  async transition_issue(input, ctx) {
    const res = await ctx.http.request({ method: 'POST', url: 'https://acme.atlassian.net/rest/api/3/issue/' + input.key + '/transitions', json: { transition: { id: '31' } }, credential: 'jira' });
    if (!res.ok) throw new ctx.ActionError('jira_' + res.status, { retryable: res.status >= 500 });
    return { done: res.status === 204 };
  },
};`;

describe('module validation', () => {
  it('sandbox tests can answer with an empty 204, as Jira does for a transition', async () => {
    const { report } = await validateModule(new ProcessRunner(), manifest, code, [
      {
        name: 'moves the issue',
        action: 'transition_issue',
        input: { key: 'APP-7' },
        http: [{ method: 'POST', urlPrefix: 'https://acme.atlassian.net/rest/api/3/issue/APP-7/transitions', status: 204, json: undefined }],
        expectOk: true,
      },
    ]);
    expect(report.tests).toEqual([expect.objectContaining({ passed: true })]);
    expect(report.passed).toBe(true);
  }, 30_000);
});

describe('sandbox tests of a feed (not JSON)', () => {
  const feed = {
    ...manifest,
    name: 'feed',
    hosts: ['www.example.com'],
    credentials: [],
    actions: [{ name: 'newest', title: 'Newest entry', description: 'Reads an Atom feed.', effect: 'read', credentials: [], input: { type: 'object', properties: {} }, output: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }],
  };
  const feedCode = `export const actions = {
  async newest(input, ctx) {
    const res = await ctx.http.request({ method: 'GET', url: 'https://www.example.com/feeds/videos.xml?channel_id=UC1' });
    const m = /<entry>[\\s\\S]*?<title>([^<]*)<\\/title>/.exec(res.body);
    if (!res.ok || !res.body.trimStart().startsWith('<') || !m) throw new ctx.ActionError('invalid_channel_feed');
    return { title: m[1] };
  },
};`;
  const xml = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Channel</title><entry><title>Newest video</title></entry></feed>';
  const url = 'https://www.example.com/feeds/videos.xml';

  it('a canned body reaches the code as the document itself', async () => {
    const { report } = await validateModule(new ProcessRunner(), feed, feedCode, [
      { name: 'reads the newest', action: 'newest', input: {}, http: [{ method: 'GET', urlPrefix: url, status: 200, body: xml, contentType: 'application/atom+xml' }], expectOk: true },
    ]);
    expect(report.tests[0]).toMatchObject({ passed: true, requests: [`GET ${url} → 200`] });
  }, 30_000);

  it('the same document given as json fails, and the report says what was expected', async () => {
    const { report } = await validateModule(new ProcessRunner(), feed, feedCode, [
      { name: 'reads the newest', action: 'newest', input: {}, http: [{ method: 'GET', urlPrefix: url, status: 200, json: xml }], expectOk: true },
      { name: 'no answer', action: 'newest', input: {}, http: [], expectOk: true },
    ]);
    expect(report.tests[0]).toMatchObject({ passed: false, errorType: 'invalid_channel_feed', expectOk: true });
    expect(report.tests[1]).toMatchObject({ passed: false, requests: [`GET ${url} → no canned answer`] });
  }, 30_000);
});

describe('sandbox tests that expect a refusal', () => {
  // The key must look like a Jira key; a header-injection attempt never fits.
  const strict = { ...manifest, actions: [{ ...manifest.actions[0]!, input: { type: 'object', properties: { key: { type: 'string', pattern: '^[A-Z]+-[0-9]+$' } }, required: ['key'] } }] };
  const ok = { name: 'moves the issue', action: 'transition_issue', input: { key: 'APP-7' }, expectOk: true, http: [{ method: 'POST', urlPrefix: 'https://acme.atlassian.net/rest/api/3/issue/APP-7/transitions', status: 204, json: undefined }] };

  it('pass when the input schema refuses their input, shown as refused by the schema; nothing is called', async () => {
    const { report } = await validateModule(new ProcessRunner(), strict, code, [ok, { name: 'refuses header injection', action: 'transition_issue', input: { key: 'APP-7\r\nX-Evil: 1' }, http: [], expectOk: false }]);
    expect(report.tests[1]).toEqual({ name: 'refuses header injection', passed: true, errorType: 'refused_by_input_schema', requests: [] });
    expect(report.passed).toBe(true);
  });

  it('a test that expects success with input the schema refuses still fails', async () => {
    const { report } = await validateModule(new ProcessRunner(), strict, code, [{ ...ok, input: { key: 'not a key' } }]);
    expect(report.tests[0]).toMatchObject({ passed: false, errorType: 'test_input_invalid' });
    expect(report.passed).toBe(false);
  });
});

describe('module validation of plain-http development hosts', () => {
  const local = {
    ...manifest,
    hosts: ['127.0.0.1:9100'],
    credentials: [{ ...manifest.credentials[0]!, hosts: ['127.0.0.1:9100'] }],
  };
  const localCode = code.replace('https://acme.atlassian.net', 'http://127.0.0.1:9100');
  const tests = [
    {
      name: 'moves the issue',
      action: 'transition_issue',
      input: { key: 'APP-7' },
      http: [{ method: 'POST', urlPrefix: 'http://127.0.0.1:9100/rest/api/3/issue/APP-7/transitions', status: 204, json: undefined }],
      expectOk: true,
    },
  ];

  it('follows the same allowance as run time: refused by default, allowed when the host is listed', async () => {
    const refused = await validateModule(new ProcessRunner(), local, localCode, tests);
    expect(refused.report.tests[0]).toMatchObject({ passed: false, errorType: 'egress_denied_scheme' });
    const allowed = await validateModule(new ProcessRunner(), local, localCode, tests, { insecureHttpHosts: ['127.0.0.1:9100'] });
    expect(allowed.report.passed).toBe(true);
  }, 30_000);
});

describe('explaining invalid Flow inputs', () => {
  it('names each field and the rule it breaks, never the value', () => {
    const schema = {
      type: 'object',
      properties: { owner: { type: 'string', pattern: '^[A-Za-z0-9-]+$' }, repo: { type: 'string' }, mode: { enum: ['a', 'b'] } },
      required: ['owner', 'repo'],
      additionalProperties: false,
    };
    const lines = ajv.explain(schema, { owner: '@SudoDevStudio', mode: 'secret-value', extra: 1 });
    expect(lines).toEqual(expect.arrayContaining(['repo: is required', 'owner: must match pattern "^[A-Za-z0-9-]+$"', 'mode: must be one of a, b', 'extra: is not an input of this Flow']));
    expect(lines.join(' ')).not.toContain('@SudoDevStudio');
    expect(lines.join(' ')).not.toContain('secret-value');
    expect(ajv.explain(schema, { owner: 'SudoDevStudio', repo: 'astro-ai' })).toEqual([]);
  });
});
