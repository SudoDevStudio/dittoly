import { afterEach, describe, expect, it } from 'vitest';
import { containerEngine, isolationOptional, networkCreateArgs, setContainerEngine } from '../src/sandbox/engine.js';
import { loadConfig } from '../src/config.js';

/**
 * Every sandbox — a module's, a fix step's, an app step's, a browser's, a local MCP server's — is one container
 * run with the flags Docker and Podman both take, so a machine with Podman and no Docker daemon runs the same
 * work, whatever the project is written in.
 */
afterEach(() => setContainerEngine(null));

describe('the container engine', () => {
  it('is whichever the operator named', async () => {
    expect(await containerEngine({ DITTOLY_CONTAINER_ENGINE: 'podman' } as NodeJS.ProcessEnv)).toBe('podman');
    expect(await containerEngine({ DITTOLY_CONTAINER_ENGINE: 'Docker' } as NodeJS.ProcessEnv)).toBe('docker');
    // Nonsense in the variable is not silently obeyed; the configuration check refuses it (below).
    setContainerEngine('podman');
    expect(await containerEngine({ DITTOLY_CONTAINER_ENGINE: 'rocket' } as NodeJS.ProcessEnv)).toBe('podman');
  });

  it('is refused at start-up when it names something else', () => {
    const env = { DITTOLY_MODE: 'local', DITTOLY_DATABASE_URL: 'postgres://x/y', DITTOLY_MASTER_KEY: 'a'.repeat(64), DITTOLY_CONTAINER_ENGINE: 'rocket' } as NodeJS.ProcessEnv;
    expect(() => loadConfig(env)).toThrow(/DITTOLY_CONTAINER_ENGINE/);
  });

  it('asks each engine for the network it can actually make', () => {
    // Docker 28 and later: a bridge with no address on the host, so a container cannot reach what the host serves.
    expect(networkCreateArgs('docker', 'dty-net-1', ['--label', 'owner=x'])).toEqual([
      'network', 'create', '--internal', '-o', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', '--label', 'owner=x', 'dty-net-1',
    ]);
    // Podman's internal networks have no gateway address at all, and it refuses Docker's option.
    expect(networkCreateArgs('podman', 'dty-net-1', ['--label', 'owner=x'])).toEqual(['network', 'create', '--internal', '--label', 'owner=x', 'dty-net-1']);
    // Only an older Docker is allowed to fall back to a network whose bridge has an address.
    expect(isolationOptional('docker')).toBe(true);
    expect(isolationOptional('podman')).toBe(false);
    expect(networkCreateArgs('docker', 'n', [], false)).toEqual(['network', 'create', '--internal', 'n']);
  });
});
