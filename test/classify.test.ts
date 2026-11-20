import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTOCOLS } from '../src/ai/protocols.js';
import { MockProvider } from '../src/ai/provider.js';
import { buildServer } from '../src/api/server.js';
import { approveExampleModules, makeWorld, type World } from './helpers.js';

/** Requests are classified by protocol, and the person answers open questions, before anything is built. */
const ai = new MockProvider();
let w: World;
let server: ReturnType<typeof buildServer>;
beforeAll(async () => {
  w = await makeWorld({}, { ai });
  server = buildServer(w.app);
});
afterAll(async () => {
  await server.close();
  await w.db.end();
});

const as = (t: string) => ({ authorization: `Bearer ${t}` });
const classification = (c: object) => ({ classificationJson: JSON.stringify(c) });
const slack = path.resolve(import.meta.dirname, 'fixtures', 'modules', 'slack');
const slackModule = async () => ({
  manifestJson: await readFile(path.join(slack, 'manifest.json'), 'utf8'),
  code: await readFile(path.join(slack, 'module.mjs'), 'utf8'),
  testsJson: await readFile(path.join(slack, 'tests.json'), 'utf8'),
});

describe('protocol catalog', () => {
  it('covers every protocol the product owner listed, each with a category and an honest support status', () => {
    const listed =
      'http https http2 http3 websocket wss rest graphql grpc soap mcp a2a json-rpc xml-rpc sse tcp udp quic ip ipv4 ipv6 dns ftp ftps sftp scp smtp imap pop3 ssh tls ssl mqtt amqp webrtc webtransport rtsp rtp smb nfs dhcp icmp webdav'.split(' ');
    const ids = new Set(PROTOCOLS.map((p) => p.id));
    expect(listed.filter((id) => !ids.has(id))).toEqual([]);
    expect(ids.size).toBe(PROTOCOLS.length);
    for (const id of ['smtp', 'amqp', 'mqtt', 'websocket', 'sse', 'rest', 'graphql', 'mcp']) expect(PROTOCOLS.find((p) => p.id === id)!.support).not.toBe('unsupported');
    for (const id of ['sftp', 'ssh', 'imap', 'grpc']) expect(PROTOCOLS.find((p) => p.id === id)!.support).toBe('unsupported');
  });
});

describe('modules: classify, then ask', () => {
  it('an email request asks provider API or SMTP first; the answer then guides the build and is kept for reviewers', async () => {
    ai.enqueue(
      classification({
        summary: 'Sends a release email.',
        category: 'email',
        protocols: ['SMTP', 'email-api', 'not-a-protocol'],
        questions: [{ id: 'delivery', question: 'Send through a provider like Mailchimp or SendGrid, or your own SMTP server?', options: ['Provider API', 'Our SMTP server'] }],
      }),
    );
    const first = await server.inject({ method: 'POST', url: '/api/modules/generate', headers: as(w.tokens.alice), payload: { request: 'Email the team when a release ships' } });
    expect(first.statusCode).toBe(200);
    const body = first.json();
    expect(body.needsAnswers).toBe(true);
    expect(body.classification.category).toBe('email');
    expect(body.classification.questions[0]).toMatchObject({ id: 'delivery', options: ['Provider API', 'Our SMTP server'] });
    // Support comes from the catalog, unknown ids are dropped.
    expect(body.classification.protocols.map((p: { id: string; support: string }) => [p.id, p.support])).toEqual([['smtp', 'supported'], ['email-api', 'supported']]);
    expect(ai.requests).toHaveLength(0); // nothing was built

    ai.enqueue(await slackModule());
    const second = await server.inject({
      method: 'POST',
      url: '/api/modules/generate',
      headers: as(w.tokens.alice),
      payload: { request: 'Email the team when a release ships', answers: { 'Provider API or SMTP?': 'Our SMTP server' } },
    });
    expect(second.statusCode).toBe(201);
    expect(ai.classifications.at(-1)!.prompt).toContain('THE PERSON ALREADY ANSWERED');
    expect(ai.requests.at(-1)!.prompt).toContain('Our SMTP server');
    expect(ai.requests.at(-1)!.prompt).toContain('CLASSIFICATION');
    expect(second.json().generation.classification).toMatchObject({ answers: { 'Provider API or SMTP?': 'Our SMTP server' } });
  });

  it('asks whether to use a key when a keyless route has trade-offs, and builds the route the person picked', async () => {
    const options = ['No key: public RSS feed (unofficial, last ~15 videos)', "With each person's own YouTube Data API key"];
    ai.enqueue(classification({ summary: 'Latest video of a channel.', category: 'web_api', protocols: ['rest'], questions: [{ id: 'access', question: 'Use a key?', options }] }));
    const first = await server.inject({ method: 'POST', url: '/api/modules/generate', headers: as(w.tokens.alice), payload: { request: 'Latest video of a YouTube channel' } });
    expect(first.json()).toMatchObject({ needsAnswers: true, classification: { questions: [{ options }] } });
    // The classifier is told to look for keyless routes and to ask when unsure, never for the key itself.
    const system = ai.classifications.at(-1)!.system;
    expect(system).toContain('NOT SURE whether it works without a key: ASK');
    expect(system).toContain('Never ask for the password, token or key itself');

    ai.enqueue(await slackModule());
    await server.inject({ method: 'POST', url: '/api/modules/generate', headers: as(w.tokens.alice), payload: { request: 'Latest video of a YouTube channel', answers: { 'Use a key?': options[0] } } });
    expect(ai.requests.at(-1)!.prompt).toContain(options[0]);
    expect(ai.requests.at(-1)!.system).toContain('When THE PERSON ALREADY ANSWERED how to connect (with or\nwithout a key), follow that answer.');
  });

  it('a protocol Dittoly cannot use is reported with the alternative before anything is built', async () => {
    ai.enqueue(classification({ summary: 'Upload reports to an SFTP server.', category: 'file_transfer', protocols: ['sftp'], questions: [] }));
    const res = await server.inject({ method: 'POST', url: '/api/modules/generate', headers: as(w.tokens.alice), payload: { request: 'Upload the report to our SFTP server' } });
    expect(res.statusCode).toBe(200);
    const p = res.json().classification.protocols[0];
    expect(p).toMatchObject({ id: 'sftp', support: 'unsupported' });
    expect(p.note).toMatch(/HTTPS API/);
  });

  it('a clear request is built at once; a classification that fails is tried once more, then nothing is built', async () => {
    ai.enqueue(classification({ summary: 'Posts to Slack.', category: 'web_api', protocols: ['rest'], questions: [] }));
    ai.enqueue(await slackModule());
    expect((await server.inject({ method: 'POST', url: '/api/modules/generate', headers: as(w.tokens.alice), payload: { request: 'Post to Slack' } })).statusCode).toBe(201);
    // One unreadable classification: asked again, then built.
    ai.enqueue({ classificationJson: 'not json' });
    ai.enqueue(classification({ summary: 'Posts to Slack.', category: 'web_api', protocols: ['rest'], questions: [] }));
    ai.enqueue(await slackModule());
    expect((await server.inject({ method: 'POST', url: '/api/modules/generate', headers: as(w.tokens.alice), payload: { request: 'Post to Slack' } })).statusCode).toBe(201);
    // Twice: the request was not checked, so nothing is built; the person tries again.
    const before = ai.requests.length;
    ai.enqueue({ classificationJson: 'not json' });
    ai.enqueue({ classificationJson: 'still not json' });
    const res = await server.inject({ method: 'POST', url: '/api/modules/generate', headers: as(w.tokens.alice), payload: { request: 'Post to Slack', answers: { 'Which workspace?': 'Ours' } } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('classification_unavailable');
    expect(ai.requests.length).toBe(before);
  });

  it('an answer that says too much, or comes in a code fence, is still read (shortened), not refused', async () => {
    const long = `Reviews a GitHub pull request from its URL and posts new inline comments. ${'It skips points already made on the same line. '.repeat(30)}`;
    ai.enqueue({ classificationJson: `Here it is:\n\`\`\`json\n${JSON.stringify({ summary: long, category: 'web_api', protocols: ['rest', 'https'], questions: [{ id: 'Which host?', question: 'q'.repeat(400), options: ['o'.repeat(200), 'GitHub.com'] }], extra: true })}\n\`\`\`` });
    const res = await server.inject({ method: 'POST', url: '/api/modules/generate', headers: as(w.tokens.alice), payload: { request: 'Review GitHub pull requests' } });
    expect(res.statusCode).toBe(200);
    const c = res.json().classification;
    expect(c.summary.length).toBe(600);
    expect(c.questions).toEqual([{ id: 'q1', question: 'q'.repeat(300), options: ['o'.repeat(120), 'GitHub.com'] }]);
    // An object instead of a JSON string is read too.
    ai.enqueue({ classificationJson: { summary: 'Posts to Slack.', category: 'web_api', protocols: ['rest'], questions: [] } });
    ai.enqueue(await slackModule());
    expect((await server.inject({ method: 'POST', url: '/api/modules/generate', headers: as(w.tokens.alice), payload: { request: 'Post to Slack' } })).statusCode).toBe(201);
  });

  it('empty or partial answers never stand in for an answer: only the open questions are asked again', async () => {
    const questions = [
      { id: 'delivery', question: 'Provider API or SMTP?', options: ['Provider API', 'Our SMTP server'] },
      { id: 'from', question: 'Which sender address?', options: [] },
    ];
    const before = ai.requests.length;
    ai.enqueue(classification({ summary: 'Sends email.', category: 'email', protocols: ['smtp'], questions }));
    const empty = await server.inject({ method: 'POST', url: '/api/modules/generate', headers: as(w.tokens.alice), payload: { request: 'Email the team', answers: {} } });
    expect(empty.json()).toMatchObject({ needsAnswers: true, classification: { questions: [{ id: 'delivery' }, { id: 'from' }] } });
    ai.enqueue(classification({ summary: 'Sends email.', category: 'email', protocols: ['smtp'], questions }));
    const partial = await server.inject({ method: 'POST', url: '/api/modules/generate', headers: as(w.tokens.alice), payload: { request: 'Email the team', answers: { 'Provider API or SMTP?': 'Our SMTP server', 'Which sender address?': '  ' } } });
    expect(partial.json()).toMatchObject({ needsAnswers: true, classification: { questions: [{ id: 'from' }] } });
    expect(ai.requests.length).toBe(before);
    // Answered by id or by the question: built, with both answers kept for reviewers.
    ai.enqueue(classification({ summary: 'Sends email.', category: 'email', protocols: ['smtp'], questions }));
    ai.enqueue(await slackModule());
    const done = await server.inject({ method: 'POST', url: '/api/modules/generate', headers: as(w.tokens.alice), payload: { request: 'Email the team', answers: { 'Provider API or SMTP?': 'Our SMTP server', from: 'ops@acme.test' } } });
    expect(done.statusCode).toBe(201);
    expect(done.json().generation.classification.answers).toEqual({ 'Provider API or SMTP?': 'Our SMTP server', from: 'ops@acme.test' });
  });

  it('answers are validated', async () => {
    const res = await server.inject({ method: 'POST', url: '/api/modules/generate', headers: as(w.tokens.alice), payload: { request: 'x', answers: { q: 'y'.repeat(1001) } } });
    expect(res.statusCode).toBe(400);
  });
});

describe('Flows: classify, then ask', () => {
  it('names the module that is missing and a request to build it, instead of drafting a Flow that cannot work', async () => {
    const w = await makeWorld({}, { ai });
    const server = buildServer(w.app);
    await approveExampleModules(w);
    ai.enqueue(
      classification({
        summary: 'Merge ready MRs, then email the team.',
        category: 'web_api',
        protocols: ['rest', 'smtp'],
        questions: [],
        missing: [{ capability: 'send email', moduleRequest: 'A module that sends email through our SMTP server.' }],
      }),
    );
    const before = ai.requests.length;
    const res = await server.inject({ method: 'POST', url: '/api/flows/generate', headers: as(w.tokens.alice), payload: { request: 'Merge ready MRs and email the team' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().classification.missing).toEqual([{ capability: 'send email', moduleRequest: 'A module that sends email through our SMTP server.' }]);
    expect(ai.classifications.at(-1)!.prompt).toContain('gitlab@1.0.0 merge_merge_request');
    expect(ai.requests.length).toBe(before);
    // Building anyway (nothing left to answer) is an explicit choice; the missing module stays on the draft for reviewers.
    ai.enqueue(
      classification({ summary: 'Merge ready MRs, then email the team.', category: 'web_api', protocols: ['rest', 'smtp'], questions: [], missing: [{ capability: 'send email', moduleRequest: 'x' }] }),
    );
    ai.enqueue({ name: 'Merge and tell', explanation: 'Merges after a check.', definitionJson: JSON.stringify({ steps: [{ id: 'gate', type: 'approval', title: 'Check' }] }) });
    const built = await server.inject({ method: 'POST', url: '/api/flows/generate', headers: as(w.tokens.alice), payload: { request: 'Merge ready MRs and email the team', answers: {} } });
    expect(built.statusCode).toBe(201);
    expect(built.json().generation.classification.missing).toEqual(['send email']);
    await server.close();
    await w.db.end();
  });
});
