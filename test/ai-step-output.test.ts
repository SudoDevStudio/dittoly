import { describe, expect, it } from 'vitest';
import { AiError, type AiProvider } from '../src/runtime/ai.js';
import { runAiStep } from '../src/runtime/ai-step.js';
import type { AiStep } from '../src/runtime/types.js';

const step: AiStep = {id:'triage',ai:'organization',output:'text',instruction:'Read the error and source; return bug or noise with evidence.'};
function answers(...results: (Record<string,unknown> | Error)[]) {
  const calls: Parameters<AiProvider['generateJson']>[0][]=[];
  const provider: AiProvider={id:'mock',async generateJson(req) {calls.push(req);const next=results.shift();if(next instanceof Error) throw next;return next ?? {};}};
  return {provider,calls};
}
describe('AI step structured output recovery',()=>{
 it('retries a provider parse failure once using the same schema and evidence',async()=>{
  const fake=answers(new AiError('ai_output_unparseable'),{text:'Expected simulated error; noise.'});
  await expect(runAiStep(step,{message:'Simulated error',source:'throw new HttpError(500)'},fake.provider)).resolves.toEqual({text:'Expected simulated error; noise.'});
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]!.schema).toEqual(fake.calls[0]!.schema);
  expect(fake.calls[1]!.prompt).toContain('Simulated error');
 });
 it('fails after a second malformed answer without a third call',async()=>{
  const fake=answers(new AiError('ai_output_unparseable'),new AiError('ai_output_unparseable'));
  await expect(runAiStep(step,{},fake.provider)).rejects.toMatchObject({code:'ai_output_unparseable'});
  expect(fake.calls).toHaveLength(2);
 });
 it('does not retry authentication errors',async()=>{
  const fake=answers(new AiError('ai_auth_failed'));
  await expect(runAiStep(step,{},fake.provider)).rejects.toMatchObject({code:'ai_auth_failed'});
  expect(fake.calls).toHaveLength(1);
 });
 it('repairs a malformed checklist JSON string',async()=>{
  const fake=answers({checksJson:'not JSON'},{checksJson:'[{"check":"Open cart"}]'});
  await expect(runAiStep({...step,output:'checklist'},{},fake.provider)).resolves.toEqual({checks:[{check:'Open cart'}]});
  expect(fake.calls).toHaveLength(2);
 });
 it('does not turn a missing text field into a successful empty answer',async()=>{
  const fake=answers({verdict:'bug'},{verdict:'bug'});
  await expect(runAiStep(step,{},fake.provider)).rejects.toMatchObject({code:'ai_response_shape'});
  expect(fake.calls).toHaveLength(2);
 });
 it('keeps an empty answer instead of failing the run',async()=>{
  const fake=answers({text:''});
  await expect(runAiStep(step,{},fake.provider)).resolves.toEqual({text:''});
  expect(fake.calls).toHaveLength(1);
 });
 it('does not retry when asked not to (the model-change check counts every failure)',async()=>{
  const fake=answers(new AiError('ai_output_unparseable'),{text:'never asked'});
  await expect(runAiStep(step,{},fake.provider,{retry:false})).rejects.toMatchObject({code:'ai_output_unparseable'});
  expect(fake.calls).toHaveLength(1);
 });
});

describe('AI step with output "json"', () => {
  const schema = { type: 'object', required: ['findings'], additionalProperties: false, properties: { findings: { type: 'array', maxItems: 5, items: { type: 'object', required: ['path', 'line', 'body'], properties: { path: { type: 'string' }, line: { type: 'integer' }, body: { type: 'string' } } } } } };
  const jsonStep: AiStep = { ...step, output: 'json', schema };
  const findings = [{ path: 'src/a.ts', line: 3, body: 'Off by one.' }];

  it('returns the answer as data, checked against the schema the AI is given', async () => {
    const fake = answers({ resultJson: JSON.stringify({ findings }) });
    await expect(runAiStep(jsonStep, { diff: '...' }, fake.provider)).resolves.toEqual({ data: { findings } });
    expect(fake.calls[0]!.system).toContain('"findings"');
    // Also from a code fence.
    const fenced = answers({ resultJson: '```json\n' + JSON.stringify({ findings: [] }) + '\n```' });
    await expect(runAiStep(jsonStep, {}, fenced.provider)).resolves.toEqual({ data: { findings: [] } });
  });

  it('an answer that does not match is asked for once more, told which fields are wrong (not their values)', async () => {
    const fake = answers({ resultJson: JSON.stringify({ findings: [{ path: 'secret-path.ts', line: 'three' }] }) }, { resultJson: JSON.stringify({ findings }) });
    await expect(runAiStep(jsonStep, {}, fake.provider)).resolves.toEqual({ data: { findings } });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.prompt).toContain('It did not match the schema: findings.0.body: is required; findings.0.line: must be integer.');
    expect(fake.calls[1]!.prompt).not.toContain('secret-path.ts');
  });

  it('fails after a second answer that does not match, or one that is not JSON', async () => {
    const twice = answers({ resultJson: '{"findings": "none"}' }, { resultJson: '{"findings": "none"}' });
    await expect(runAiStep(jsonStep, {}, twice.provider)).rejects.toMatchObject({ code: 'ai_answer_not_matching' });
    const notJson = answers({ resultJson: 'here you go' }, { resultJson: 'still not' });
    // The answer itself goes with the error: the run's commentary shows it, so a person can see what the model wrote.
    await expect(runAiStep(jsonStep, {}, notJson.provider)).rejects.toMatchObject({ code: 'ai_response_not_json', raw: 'still not' });
  });
});
