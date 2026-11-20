import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/ai/provider.js';
import { providerFor, StepError } from '../src/runtime/ai-step.js';

/** Which AI an AI step uses: the organization's, or the runner's own key, named in the error when it is missing. */
const deps = (keys: Record<string, string>, organization: MockProvider | null = null) => {
  const built: { provider: string; key: string }[] = [];
  return {
    built,
    d: {
      organization,
      secret: async (service: string) => keys[service] ?? null,
      runnerProvider: (provider: 'openai' | 'anthropic', key: string) => (built.push({ provider, key }), new MockProvider()),
    },
  };
};
const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: StepError) => e.code);

describe("an AI step with the runner's own key", () => {
  it('without a provider named: the OpenAI key, else the Anthropic key', async () => {
    const both = deps({ openai: 'sk-o', anthropic: 'sk-a' });
    await providerFor({ ai: 'runner' }, both.d);
    expect(both.built).toEqual([{ provider: 'openai', key: 'sk-o' }]);
    const anthropicOnly = deps({ anthropic: 'sk-a' });
    await providerFor({ ai: 'runner' }, anthropicOnly.d);
    expect(anthropicOnly.built).toEqual([{ provider: 'anthropic', key: 'sk-a' }]);
  });

  it('says which personal credential is missing', async () => {
    expect(await code(providerFor({ ai: 'runner' }, deps({}).d))).toBe('ai_key_missing');
    expect(await code(providerFor({ ai: 'runner', provider: 'anthropic' }, deps({ openai: 'sk-o' }).d))).toBe('ai_key_missing_anthropic');
    expect(await code(providerFor({ ai: 'runner', provider: 'openai' }, deps({ anthropic: 'sk-a' }).d))).toBe('ai_key_missing_openai');
  });

  it("without the runner's key, the organization's AI (whatever Dittoly uses, a CLI included)", async () => {
    const org = new MockProvider();
    expect(await providerFor({ ai: 'runner' }, deps({}, org).d)).toBe(org);
    expect(await providerFor({ ai: 'runner', provider: 'openai' }, deps({ anthropic: 'sk-a' }, org).d)).toBe(org);
    // A stored key still wins.
    const keyed = deps({ anthropic: 'sk-a' }, org);
    expect(await providerFor({ ai: 'runner' }, keyed.d)).not.toBe(org);
    expect(keyed.built).toEqual([{ provider: 'anthropic', key: 'sk-a' }]);
  });

  it("the organization's AI needs no personal key", async () => {
    expect(await code(providerFor({ ai: 'organization' }, deps({}, new MockProvider()).d))).toBe('ok');
  });
});
