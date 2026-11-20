import { homedir } from 'node:os';
import path from 'node:path';

/** The single-user install's data folder: DITTOLY_HOME, else ~/.dittoly. */
export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DITTOLY_HOME || path.join(homedir(), '.dittoly');
}
