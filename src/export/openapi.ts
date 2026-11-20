import type { AppBundle } from './bundle.js';

/** OpenAPI 3.1 for an exported app's API, with each Flow's own input schema. */
export function openapi(b: AppBundle): Record<string, unknown> {
  const exposed = b.flows.filter((f) => f.exposed);
  const runResult = {
    type: 'object',
    properties: {
      runId: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['running', 'waiting', 'paused', 'succeeded', 'failed', 'cancelled'] },
      runToken: { type: 'string', description: 'Lets whoever started the run read it and answer its forms (X-Run-Token header).' },
      run: { $ref: '#/components/schemas/Run' },
    },
    required: ['runId', 'status', 'runToken'],
  };
  const paths: Record<string, unknown> = {
    '/health': { get: { summary: 'Liveness', responses: { 200: { description: 'OK' } } } },
    '/api/app': { get: { summary: 'The app: its name, theme, page plan and Flows', responses: { 200: { description: 'OK' } } } },
    '/api/runs': {
      get: {
        summary: 'Recent runs',
        security: [{ bearer: [] }],
        parameters: [
          { name: 'flow', in: 'query', schema: { type: 'string', enum: exposed.map((f) => f.key) } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        ],
        responses: { 200: { description: 'OK' }, 401: { description: 'Missing or wrong token' } },
      },
    },
    '/api/runs/{runId}': {
      get: {
        summary: 'A run, its step results and what it waits for',
        security: [{ bearer: [] }, { runToken: [] }],
        parameters: [{ name: 'runId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Run' } } } }, 404: { description: 'No such run' } },
      },
    },
    '/api/runs/{runId}/steps/{stepId}/decision': {
      post: {
        summary: 'Approve or reject a step waiting for approval (admin token)',
        security: [{ bearer: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { decision: { type: 'string', enum: ['approved', 'rejected'] } }, required: ['decision'] } } } },
        responses: { 204: { description: 'Decided' }, 409: { description: 'Not waiting for a decision' } },
      },
    },
    '/api/runs/{runId}/steps/{stepId}/input': {
      post: {
        summary: 'Answer a form the run waits for (admin token or the run token)',
        security: [{ bearer: [] }, { runToken: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { values: { type: 'object' } }, required: ['values'] } } } },
        responses: { 204: { description: 'Accepted' }, 400: { description: 'Invalid answers' } },
      },
    },
    '/api/inbox': { get: { summary: 'Steps waiting for a person (admin token)', security: [{ bearer: [] }], responses: { 200: { description: 'OK' } } } },
  };
  for (const f of exposed) {
    paths[`/api/flows/${f.key}/runs`] = {
      post: {
        summary: `Run ${f.name}`,
        description: `${f.description}${f.access === 'public' ? ' Public: no token needed (rate limited).' : ''}`,
        ...(f.access === 'token' ? { security: [{ bearer: [] }] } : {}),
        parameters: [{ name: 'wait', in: 'query', description: 'Seconds to wait for the run to finish or stop for a person (0-30).', schema: { type: 'integer', minimum: 0, maximum: 30, default: 0 } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { inputs: f.definition.inputs ?? { type: 'object' } }, required: ['inputs'] } } } },
        responses: { 201: { description: 'Started', content: { 'application/json': { schema: runResult } } }, 400: { description: 'Invalid inputs' }, 429: { description: 'Too many runs' } },
      },
    };
  }
  for (const h of b.hooks) {
    paths[`/hooks/${h.flow}`] = { post: { summary: `Webhook (${h.provider}) that runs ${h.flow}`, description: `Signed with ${h.env}.`, responses: { 202: { description: 'Accepted' }, 401: { description: 'Bad signature' } } } };
  }
  return {
    openapi: '3.1.0',
    info: { title: b.name, version: b.sha256.slice(0, 12), description: `Exported from Dittoly ${b.dittolyVersion}.` },
    paths,
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'APP_API_TOKEN, or APP_ADMIN_TOKEN for decisions and the inbox.' },
        runToken: { type: 'apiKey', in: 'header', name: 'X-Run-Token' },
      },
      schemas: {
        Run: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            flow: { type: 'string' },
            status: { type: 'string' },
            waitReason: { type: ['string', 'null'] },
            createdAt: { type: 'string', format: 'date-time' },
            finishedAt: { type: ['string', 'null'], format: 'date-time' },
            steps: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string' }, title: { type: ['string', 'null'] }, status: { type: 'string' }, errorType: { type: ['string', 'null'] }, output: {} } } },
            waiting: { type: 'array', items: { type: 'object', properties: { stepId: { type: 'string' }, kind: { type: 'string', enum: ['approval', 'input'] }, title: { type: ['string', 'null'] }, form: {} } } },
            result: { description: 'The output of the last step that produced one.' },
          },
        },
      },
    },
  };
}
