import { transform, type Message } from 'esbuild';
import { AppError } from '../core/errors.js';

/**
 * Modules are written in TypeScript and run as JavaScript. Dittoly compiles the source itself, here, whenever a
 * version is stored: the TypeScript is what people read (on the module's page, in diffs and in git) and the compiled
 * JavaScript is what the sandbox runs. Both are stored with the version and neither can change afterwards, so the
 * approval covers what was read and what runs. Types are only removed, never checked: a repository that wants type
 * checks runs `npm run check` (see the git sync docs).
 *
 * The same esbuild version, with these options, gives the same output for the same source, in Dittoly and in a
 * synced repository's `npm run build`.
 */
export const COMPILE_OPTIONS = { loader: 'ts', format: 'esm', target: 'esnext', charset: 'utf8', legalComments: 'none' } as const;

/** Like the code limit the sandbox enforces on what it runs. */
export const MAX_SOURCE_CHARS = 200_000;

export async function compileModuleSource(source: string): Promise<string> {
  if (source.length > MAX_SOURCE_CHARS) throw new AppError('invalid_module_source', 400, `module.ts is longer than ${MAX_SOURCE_CHARS} characters`);
  try {
    return (await transform(source, { ...COMPILE_OPTIONS, sourcefile: 'module.ts' })).code;
  } catch (err) {
    const errors = (err as { errors?: Message[] }).errors;
    if (!Array.isArray(errors)) throw err;
    // Only the compiler's own words and positions: the source itself is not repeated.
    const where = (m: Message) => (m.location ? `module.ts:${m.location.line}:${m.location.column + 1}: ` : 'module.ts: ');
    throw new AppError('invalid_module_source', 400, errors.slice(0, 5).map((m) => `${where(m)}${m.text}`).join('; ').slice(0, 1000));
  }
}

/**
 * What to compare between two versions, for people: the TypeScript when both have it, else the code that runs (so a
 * module's first TypeScript version is compared with the JavaScript before it on the same footing).
 */
export function readablePair(from: { code: string; source: string | null }, to: { code: string; source: string | null }): [string, string] {
  return from.source !== null && to.source !== null ? [from.source, to.source] : [from.code, to.code];
}
