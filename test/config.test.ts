import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createProvider } from '../src/ai/factory.js';
import { ConfigError, loadConfig } from '../src/config.js';

const base = {
  DATABASE_URL: 'postgres://x',
  DITTOLY_MASTER_KEY: randomBytes(32).toString('base64'),
  DITTOLY_AMQP_URL: 'amqp://rabbit.internal',
};

describe('what the server says about a setting it cannot use', () => {
  it('names the setting, what it expected and what it read — never a secret', () => {
    const bad = (env: Record<string, string>) => {
      try {
        loadConfig({ ...base, DITTOLY_MODE: 'local', ...env });
        return '';
      } catch (err) {
        return (err as Error).message;
      }
    };
    expect(bad({ DITTOLY_AI_PROVIDER: 'gemma4:26b' })).toContain('DITTOLY_AI_PROVIDER');
    expect(bad({ DITTOLY_AI_PROVIDER: 'gemma4:26b' })).toContain('ollama');
    // What it read, so nobody has to guess which character it disliked (a model name in the provider's place).
    expect(bad({ DITTOLY_AI_PROVIDER: 'gemma4:26b' })).toContain('read: "gemma4:26b"');
    expect(bad({ DITTOLY_OLLAMA_NUM_CTX: '32k' })).toMatch(/DITTOLY_OLLAMA_NUM_CTX.*read: "32k"/);
    expect(bad({ DITTOLY_OLLAMA_NUM_CTX: '2048' })).toMatch(/>=\s*4096.*read: "2048"/);
    // A value that may hold a secret is named, never shown.
    const secret = bad({ DITTOLY_MASTER_KEY: 'not-base64-at-all!!' });
    expect(secret).toContain('DITTOLY_MASTER_KEY');
    expect(secret).not.toContain('not-base64-at-all');
  });
});

describe('deployment mode rules', () => {
  it.each(['codex-cli', 'claude-cli'])('%s cannot be turned on in a multi-user install', (provider) => {
    expect(() => loadConfig({ ...base, DITTOLY_MODE: 'shared', DITTOLY_AI_PROVIDER: provider })).toThrow(ConfigError);
    expect(() => createProvider('shared', provider as 'codex-cli')).toThrow(ConfigError);
  });

  it.each(['codex-cli', 'claude-cli'])('%s is allowed in the local install', (provider) => {
    const c = loadConfig({ ...base, DITTOLY_MODE: 'local', DITTOLY_AI_PROVIDER: provider });
    expect(c.aiProvider).toBe(provider);
    expect(createProvider('local', provider as 'codex-cli')?.id).toBe(provider);
  });

  it('more providers for admins to switch to: CLI logins only in the local install', () => {
    expect(loadConfig({ ...base, DITTOLY_MODE: 'shared', DITTOLY_AI_PROVIDER: 'anthropic', DITTOLY_AI_PROVIDERS: 'openai, anthropic' }).aiExtraProviders).toEqual(['openai', 'anthropic']);
    expect(() => loadConfig({ ...base, DITTOLY_MODE: 'shared', DITTOLY_AI_PROVIDERS: 'claude-cli' })).toThrow(/only allowed in local mode/);
    expect(loadConfig({ ...base, DITTOLY_MODE: 'local', DITTOLY_AI_PROVIDERS: 'codex-cli' }).aiExtraProviders).toEqual(['codex-cli']);
    expect(() => loadConfig({ ...base, DITTOLY_MODE: 'local', DITTOLY_AI_PROVIDERS: 'mock' })).toThrow(/DITTOLY_AI_PROVIDERS/);
  });

  it('shared mode defaults to the docker sandbox and refuses the process sandbox', () => {
    expect(loadConfig({ ...base, DITTOLY_MODE: 'shared' }).sandbox).toBe('docker');
    expect(() => loadConfig({ ...base, DITTOLY_MODE: 'shared', DITTOLY_SANDBOX: 'process' })).toThrow(/docker/);
    expect(loadConfig({ ...base, DITTOLY_MODE: 'local' }).sandbox).toBe('process');
  });

  it('a shared server needs RabbitMQ for webhooks; the local install does not', () => {
    const { DITTOLY_AMQP_URL: _, ...noQueue } = base;
    expect(() => loadConfig({ ...noQueue, DITTOLY_MODE: 'shared' })).toThrow(/DITTOLY_AMQP_URL/);
    expect(loadConfig({ ...noQueue, DITTOLY_MODE: 'local' }).amqpUrl).toBeUndefined();
    expect(() => loadConfig({ ...base, DITTOLY_MODE: 'shared', DITTOLY_AMQP_URL: 'http://rabbit' })).toThrow(ConfigError);
  });

  it('empty settings from a .env template count as not set', () => {
    const c = loadConfig({ ...base, DITTOLY_MODE: 'shared', DITTOLY_OIDC_ISSUER: '', DITTOLY_OIDC_CLIENT_ID: '', DITTOLY_AI_MODEL: ' ' });
    expect(c.oidc).toBeNull();
    expect(c.aiModel).toBeUndefined();
    expect(() => loadConfig({ ...base, DITTOLY_MODE: 'shared', DITTOLY_MASTER_KEY: '' })).toThrow(/DITTOLY_MASTER_KEY/);
  });

  it('chat notification settings are checked at startup', () => {
    expect(loadConfig({ ...base, DITTOLY_MODE: 'local', DITTOLY_SLACK_BOT_TOKEN: 'xoxb-1', DITTOLY_TEAMS_WEBHOOK_URL: 'https://x.webhook.office.com/a' })).toMatchObject({
      slackBotToken: 'xoxb-1',
      teamsWebhookUrl: 'https://x.webhook.office.com/a',
    });
    expect(() => loadConfig({ ...base, DITTOLY_MODE: 'local', DITTOLY_SLACK_BOT_TOKEN: 'xoxp-user-token' })).toThrow(/DITTOLY_SLACK_BOT_TOKEN/);
    expect(() => loadConfig({ ...base, DITTOLY_MODE: 'local', DITTOLY_TEAMS_WEBHOOK_URL: 'http://x.example/a' })).toThrow(/DITTOLY_TEAMS_WEBHOOK_URL/);
  });

  it('plain-http development hosts are local only', () => {
    expect(() => loadConfig({ ...base, DITTOLY_MODE: 'shared', DITTOLY_INSECURE_HTTP_HOSTS: 'localhost:9000' })).toThrow(ConfigError);
    expect(loadConfig({ ...base, DITTOLY_MODE: 'local', DITTOLY_INSECURE_HTTP_HOSTS: 'localhost:9000' }).insecureHttpHosts).toEqual([
      'localhost:9000',
    ]);
  });

  it('config errors name settings, never values', () => {
    const key = 'not-a-valid-key-but-secret-looking';
    try {
      loadConfig({ ...base, DITTOLY_MODE: 'shared', DITTOLY_MASTER_KEY: key });
    } catch (e) {
      expect(String(e)).not.toContain(key);
      return;
    }
    throw new Error('expected a ConfigError');
  });

  describe('where it listens', () => {
    const local = { ...base, DITTOLY_MODE: 'local' };
    it('npm start -- --host=0.0.0.0 (an argument) and npm start --host=0.0.0.0 (npm sets npm_config_host) both win over HOST', () => {
      expect(loadConfig({ ...local, HOST: '127.0.0.1' }, ['--host=0.0.0.0']).host).toBe('0.0.0.0');
      expect(loadConfig({ ...local, HOST: '127.0.0.1' }, ['--host', '0.0.0.0', '--port', '9000'])).toMatchObject({ host: '0.0.0.0', port: 9000 });
      expect(loadConfig({ ...local, HOST: '127.0.0.1', npm_config_host: '0.0.0.0', npm_config_port: '9001' }, [])).toMatchObject({ host: '0.0.0.0', port: 9001 });
      // An argument wins over npm's variable; without either, HOST stays.
      expect(loadConfig({ ...local, npm_config_host: '10.0.0.5' }, ['--host=0.0.0.0']).host).toBe('0.0.0.0');
      expect(loadConfig({ ...local, HOST: '192.168.1.20' }, []).host).toBe('192.168.1.20');
    });

    it('only npm start applies them: callers without arguments (the local launcher) keep their HOST', () => {
      expect(loadConfig({ ...local, HOST: '127.0.0.1', npm_config_host: '0.0.0.0' }).host).toBe('127.0.0.1');
    });

    it('on every address, links use an address people can open, never 0.0.0.0; DITTOLY_PUBLIC_URL still wins', () => {
      const c = loadConfig({ ...local, PORT: '8080' }, ['--host=0.0.0.0']);
      expect(c.publicUrl).toMatch(/^http:\/\/(\d+\.\d+\.\d+\.\d+|localhost):8080$/);
      expect(c.publicUrl).not.toContain('0.0.0.0');
      expect(loadConfig({ ...local, DITTOLY_PUBLIC_URL: 'https://dittoly.acme.example/' }, ['--host=0.0.0.0']).publicUrl).toBe('https://dittoly.acme.example');
      // The .env template's localhost address gives way on the network, unless single sign-on needs it.
      expect(loadConfig({ ...local, PORT: '8080', DITTOLY_PUBLIC_URL: 'http://localhost:8080' }, ['--host=0.0.0.0']).publicUrl).not.toContain('localhost:8080');
      expect(loadConfig({ ...local, PORT: '8080', DITTOLY_PUBLIC_URL: 'http://localhost:8080' }, []).publicUrl).toBe('http://localhost:8080');
      // HOST=0.0.0.0 in .env (a container reached through a port mapping): the set address stays.
      expect(loadConfig({ ...local, HOST: '0.0.0.0', PORT: '8080', DITTOLY_PUBLIC_URL: 'http://localhost:8080' }, []).publicUrl).toBe('http://localhost:8080');
      expect(loadConfig({ ...local, DITTOLY_MODE: 'shared', DITTOLY_PUBLIC_URL: 'http://localhost:8080', DITTOLY_OIDC_ISSUER: 'https://id.acme.example', DITTOLY_OIDC_CLIENT_ID: 'x', DITTOLY_OIDC_CLIENT_SECRET: 'y' }, ['--host=0.0.0.0']).publicUrl).toBe('http://localhost:8080');
      expect(loadConfig({ ...local, PORT: '8080' }, ['--host=::1']).publicUrl).toBe('http://[::1]:8080');
    });

    it('refuses a host that is not a host name or address', () => {
      expect(() => loadConfig(local, ['--host=http://0.0.0.0'])).toThrow(/HOST/);
    });
  });
});
