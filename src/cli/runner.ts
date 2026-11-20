// The code runner: app and fix steps of a Dittoly server, on this machine (docs/code-runner.md).
//   npm run runner                     (from source)
//   node dist/src/cli/runner.js        (Docker image)
// Dittoly uses it with DITTOLY_CODE_RUNNER=remote, DITTOLY_RUNNER_URL and the same DITTOLY_RUNNER_TOKEN.
import { ConfigError } from '../config.js';
import { log } from '../core/log.js';
import { AppRunner } from '../engine/apps.js';
import { loadRunnerConfig } from '../runner/config.js';
import { RunnerHousekeeping } from '../runner/housekeeping.js';
import { RunnerServer } from '../runner/server.js';

try {
  const config = loadRunnerConfig();
  const housekeeping = new RunnerHousekeeping(config.stateDir, { ttlHours: config.imageTtlHours });
  const apps = new AppRunner({ mode: 'shared', internalHosts: config.internalHosts, directAllowed: async () => false, onImage: (image) => housekeeping.onImage(image), publishApps: true });
  if (!(await apps.dockerAvailable())) throw new ConfigError('the runner needs Docker or Podman: steps run only in its sandboxes');
  await housekeeping.start();
  const server = new RunnerServer({ token: config.token, apps, slots: config.slots, tls: config.tls });
  const port = await server.listen(config.port, config.host);
  const tidy = setInterval(() => void housekeeping.removeUnusedImages().catch(() => undefined), 10 * 60_000);
  tidy.unref();
  log.info(config.tls ? 'runner_listening_tls' : 'runner_listening', { count: config.slots });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(tidy);
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
} catch (err) {
  process.stderr.write(`dittoly runner: ${err instanceof Error ? err.message : 'failed to start'}\n`);
  process.exit(1);
}
