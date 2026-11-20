import { gzipSync } from 'node:zlib';

/**
 * A minimal POSIX ustar writer for export bundles: regular files only, paths under 100 bytes
 * in the name field or split across prefix/name, modes 0644 (0755 for executables).
 */

export interface TarFile {
  path: string;
  content: string | Buffer;
  executable?: boolean;
}

function header(path: string, size: number, mode: number, mtime: number): Buffer {
  const h = Buffer.alloc(512);
  let name = path;
  let prefix = '';
  if (Buffer.byteLength(path) > 100) {
    const cut = path.lastIndexOf('/', 155);
    if (cut <= 0 || Buffer.byteLength(path.slice(cut + 1)) > 100) throw new Error(`path too long for tar: ${path}`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  const put = (s: string, off: number, len: number) => h.write(s, off, len, 'utf8');
  const octal = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(mtime, 12), 136, 12);
  put('        ', 148, 8); // checksum placeholder
  put('0', 156, 1);
  put('ustar\u0000', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

/** A .tar.gz of the files, in the order given, all under one top directory. */
export function tarGz(files: TarFile[], mtime = Math.floor(Date.now() / 1000)): Buffer {
  const parts: Buffer[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (!f.path || f.path.startsWith('/') || f.path.split('/').includes('..')) throw new Error(`bad path in bundle: ${f.path}`);
    if (seen.has(f.path)) throw new Error(`duplicate path in bundle: ${f.path}`);
    seen.add(f.path);
    const body = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8');
    parts.push(header(f.path, body.length, f.executable ? 0o755 : 0o644, mtime), body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
