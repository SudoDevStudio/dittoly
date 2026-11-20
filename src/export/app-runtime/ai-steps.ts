import type { AiProvider } from '../../runtime/ai.js';
import { providerFor, runAiStep } from '../../runtime/ai-step.js';
import type { AiSteps } from './engine.js';
import type { AppEnv } from './env.js';

/** AI steps, with the organization's AI that AI_PROVIDER names. Only apps with AI steps have this file. */

export async function aiSteps(env: AppEnv, test: { runner?: (provider: 'openai' | 'anthropic', apiKey: string) => AiProvider } = {}): Promise<AiSteps> {
  const organization = await organizationAi(env);
  return {
    async run(step, input, secret) {
      return runAiStep(step, input, await providerFor(step, { organization, secret, runnerProvider: test.runner }));
    },
  };
}

async function organizationAi(env: AppEnv): Promise<AiProvider | null> {
  const { provider, apiKey, model, ollamaUrl } = env.ai;
  if (provider === 'anthropic') {
    const { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } = await import('../../runtime/ai-anthropic.js');
    return new AnthropicProvider(model ?? DEFAULT_ANTHROPIC_MODEL, { apiKey: apiKey!, timeoutMs: 120_000 });
  }
  if (provider === 'openai') {
    const { DEFAULT_OPENAI_MODEL, OpenAiProvider } = await import('../../runtime/ai-openai.js');
    return new OpenAiProvider(model ?? DEFAULT_OPENAI_MODEL, { apiKey: apiKey!, timeoutMs: 120_000 });
  }
  if (provider === 'ollama') {
    const { OllamaProvider } = await import('../../runtime/ai-ollama.js');
    return ollamaUrl ? new OllamaProvider(model!, ollamaUrl) : new OllamaProvider(model!);
  }
  return null;
}
