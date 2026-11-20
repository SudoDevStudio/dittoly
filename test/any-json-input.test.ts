import { describe, expect, it } from 'vitest';
import { anyJsonInput, fitBody } from '../src/endpoints/service.js';

/** A Flow URL passes the whole body to a Flow whose only input takes any JSON. */
describe('a Flow input that takes any JSON', () => {
  it('is the only input, with no type', () => {
    expect(anyJsonInput({ type: 'object', properties: { payload: { description: 'anything' } }, required: ['payload'] })).toBe('payload');
    expect(anyJsonInput({ type: 'object', properties: { payload: {} } })).toBe('payload');
  });

  it('is not an input with a type, one of several, or a fixed value', () => {
    expect(anyJsonInput({ type: 'object', properties: { payload: { type: 'object' } } })).toBeNull();
    expect(anyJsonInput({ type: 'object', properties: { a: {}, b: {} } })).toBeNull();
    expect(anyJsonInput({ type: 'object', properties: { mode: { enum: ['a', 'b'] } } })).toBeNull();
    expect(anyJsonInput({ type: 'object', properties: {} })).toBeNull();
    expect(anyJsonInput(undefined)).toBeNull();
  });
});

/** Without a body mapping, a Flow URL fits any JSON to the Flow's inputs. */
describe('fitting a posted body to the inputs', () => {
  const inputs = (properties: Record<string, unknown>) => ({ type: 'object', properties });
  const log = { service: 'node-api', level: 'error', message: 'Boom', error: { name: 'HttpError', stack: 'HttpError: Boom\n    at x (/app/src/app.js:1:1)' } };

  it('leaves a body that already is the inputs', () => {
    expect(fitBody(inputs({ service: { type: 'string' }, message: { type: 'string' } }), { service: 'a', message: 'b' })).toBeNull();
    expect(fitBody(inputs({}), {})).toBeNull();
  });

  it('gives a Flow with one input the whole body, as text for a text input', () => {
    expect(fitBody(inputs({ payload: {} }), log)).toEqual({ payload: log });
    expect(fitBody(inputs({ report: { type: 'object' } }), log)).toEqual({ report: log });
    expect(fitBody(inputs({ errorJson: { type: 'string' } }), log)).toEqual({ errorJson: JSON.stringify(log) });
    expect(fitBody(inputs({ errors: { type: 'array' } }), log)).toEqual({ errors: [log] });
  });

  it('takes each input from the field of its name, anywhere in the body, and ignores the rest', () => {
    const fitted = fitBody(inputs({ service: { type: 'string' }, message: { type: 'string' }, stack: { type: 'string' }, commit: { type: 'string' } }), log);
    expect(fitted).toEqual({ service: 'node-api', message: 'Boom', stack: log.error.stack });
    // A Flow with no inputs runs with none.
    expect(fitBody(inputs({}), log)).toEqual({});
    // Casing differs: still found.
    expect(fitBody(inputs({ requestid: { type: 'string' }, path: { type: 'string' } }), { requestId: 'r1', path: '/users' })).toEqual({ requestid: 'r1', path: '/users' });
  });
});
