import { assertModeRules, ConfigError, LOCAL_ONLY_PROVIDERS, type AiProviderId, type DeploymentMode } from '../config.js';
import { AnthropicProvider } from '../runtime/ai-anthropic.js';
import { OllamaProvider } from '../runtime/ai-ollama.js';
import { OpenAiProvider } from '../runtime/ai-openai.js';
import { ClaudeCliProvider, CodexCliProvider, MockProvider, type AiProvider } from './provider.js';

export interface ProviderOptions {
  model?: string | undefined;
  ollamaUrl?: string | undefined;
  /** For a model the organization runs itself: how large a context to ask for, and how to sample. */
  ollama?: { maxContext?: number; temperature?: number; topP?: number; topK?: number } | undefined;
}

export function createProvider(mode: DeploymentMode, id: AiProviderId, opts: ProviderOptions = {}): AiProvider | null {
  // Enforced here as well as at config load, so no code path can build a CLI provider on a shared server.
  if (mode === 'shared' && LOCAL_ONLY_PROVIDERS.has(id)) {
    assertModeRules({ mode, aiProvider: id, sandbox: 'docker', insecureHttpHosts: [] });
    throw new ConfigError('unreachable');
  }
  switch (id) {
    case 'claude-cli':
      return new ClaudeCliProvider(opts.model);
    case 'codex-cli':
      return new CodexCliProvider(opts.model);
    case 'anthropic':
      return new AnthropicProvider(opts.model);
    case 'openai':
      // The OpenAI SDK resolves credentials at construction; fail at startup with a clear message.
      if (!process.env.OPENAI_API_KEY) throw new ConfigError('the openai provider needs OPENAI_API_KEY');
      return new OpenAiProvider(opts.model);
    case 'ollama':
      if (!opts.model) throw new ConfigError('the ollama provider needs DITTOLY_AI_MODEL (a model pulled on the Ollama server)');
      return new OllamaProvider(opts.model, opts.ollamaUrl, undefined, opts.ollama ?? {});
    case 'mock':
      return new MockProvider();
    case 'none':
      return null;
  }
}
