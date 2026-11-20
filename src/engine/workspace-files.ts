import { spawn } from 'node:child_process';
import { lstat, mkdir, open, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The files of a fix step's clone, as the fix step uses them (src/engine/fix.ts): list, read, write, delete and
 * Dittoly's own git on its copy of the repository data. Every path is relative to the clone and checked to stay
 * inside it. The same operations run on this machine or, with a remote code runner, on the runner machine
 * (src/runner/server.ts), so the fix step is the same either way.
 */

/** A path or file the AI may not use; the AI sees the reason, and the step goes on. */
export class Refused extends Error {}

/** The git subcommands the fix step runs (the remote runner refuses any other). */
export const FIX_GIT_COMMANDS = ['cat-file', 'status', 'grep', 'add', 'diff'] as const;

export interface WorkspaceFiles {
  /** The entries of a folder, one per line ("name/" for a folder). */
  list(rel: string): Promise<string>;
  /** The first `max` bytes of a file and its size; refused when it is not a file. */
  read(rel: string, max: number): Promise<{ data: Buffer; size: number }>;
  /** Write a file (creating its folders), or remove it (null). Returns its path as the clone has it. */
  write(rel: string, content: Buffer | null): Promise<string>;
  /** A path as the clone has it (links resolved), and whether it is a file. */
  resolve(rel: string): Promise<{ path: string; isFile: boolean }>;
  /** Dittoly's own git on the repository data (hooks and configuration off). */
  git(args: string[], max: number): Promise<{ code: number | null; out: Buffer }>;
}

const BAD_SEGMENT = (seg: string) => seg === '..' || seg.toLowerCase() === '.git';

/**
 * A path inside the clone: relative, no "..", not into the repository data, and (once symlinks
 * are resolved) still inside. A path that does not exist yet is checked through its nearest
 * existing folder.
 */
export async function safePath(root: string, rel: string): Promise<string> {
  const p = rel.trim();
  if (p.includes('\0') || p.includes('\\') || path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) throw new Refused('path_outside_workspace');
  const parts = p.split('/').filter((x) => x !== '' && x !== '.');
  if (parts.some(BAD_SEGMENT)) throw new Refused('path_outside_workspace');
  const realRoot = await realpath(root);
  const inside = (real: string) => real === realRoot || real.startsWith(realRoot + path.sep);
  // Each part that exists, in order: a symbolic link must resolve, and inside the clone.
  let probe = realRoot;
  for (const part of parts) {
    probe = path.join(probe, part);
    const st = await lstat(probe).catch(() => null);
    if (!st) break;
    if (st.isSymbolicLink()) {
      const real = await realpath(probe).catch(() => null);
      if (!real || !inside(real)) throw new Refused('path_outside_workspace');
    }
  }
  const target = path.join(realRoot, ...parts);
  const real = await realpath(target).catch(() => null);
  if (real && !inside(real)) throw new Refused('path_outside_workspace');
  return target;
}

const relOf = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');

/** The files of a clone on this machine: `root` the working tree, `gitDir` its repository data (moved out of it). */
export function localFiles(root: string, gitDir: string): WorkspaceFiles {
  return {
    async list(rel) {
      const abs = await safePath(root, rel);
      const entries = (await readdir(abs, { withFileTypes: true })).filter((e) => e.name !== '.git').sort((a, b) => a.name.localeCompare(b.name));
      const shown = entries.slice(0, 300).map((e) => (e.isDirectory() ? `${e.name}/` : e.isSymbolicLink() ? `${e.name} (link)` : e.name));
      return shown.join('\n') + (entries.length > 300 ? `\n… ${entries.length - 300} more` : '') || '(empty)';
    },
    async read(rel, max) {
      const abs = await safePath(root, rel);
      if (!(await stat(abs).catch(() => null))?.isFile()) throw new Refused('not_a_file');
      const fh = await open(abs, 'r');
      try {
        const size = (await fh.stat()).size;
        const buf = Buffer.alloc(Math.min(size, max));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        return { data: buf.subarray(0, bytesRead), size };
      } finally {
        await fh.close();
      }
    },
    async write(rel, content) {
      if (!rel.trim()) throw new Refused('path_required');
      const realRoot = await realpath(root);
      const abs = await safePath(root, rel);
      const existing = await lstat(abs).catch(() => null);
      if (existing && !existing.isFile()) throw new Refused('not_a_file');
      if (content === null) {
        if (existing) await unlink(abs);
      } else {
        await mkdir(path.dirname(abs), { recursive: true });
        // Created folders are checked again: none of them may lead outside.
        await safePath(root, relOf(realRoot, path.dirname(abs)));
        await writeFile(abs, content);
      }
      return relOf(realRoot, abs);
    },
    async resolve(rel) {
      const abs = await safePath(root, rel);
      return { path: relOf(await realpath(root), abs), isFile: !!(await stat(abs).catch(() => null))?.isFile() };
    },
    git(args, max) {
      return new Promise((resolve) => {
        const child = spawn('git', ['--git-dir', gitDir, '--work-tree', root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.quotepath=false', ...args], {
          cwd: root,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: gitDir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_LITERAL_PATHSPECS: '1', GIT_TERMINAL_PROMPT: '0' },
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const chunks: Buffer[] = [];
        let size = 0;
        child.stdout.on('data', (d: Buffer) => {
          if (size < max) chunks.push(d);
          size += d.length;
        });
        child.on('error', () => resolve({ code: null, out: Buffer.alloc(0) }));
        child.on('close', (code) => resolve({ code, out: Buffer.concat(chunks).subarray(0, max) }));
      });
    },
  };
}
