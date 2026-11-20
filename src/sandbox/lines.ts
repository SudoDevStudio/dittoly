import type { Readable } from 'node:stream';

/**
 * Newline-delimited messages from a sandboxed child, with a hard size limit. Unlike
 * node:readline, which keeps growing its buffer until a newline arrives, this stops as soon
 * as a line in progress passes `max` bytes, so a child that never sends a newline cannot
 * exhaust the server's memory.
 */
export function readLines(stream: Readable, max: number, onLine: (line: string) => void, onTooLarge: () => void): void {
  let parts: Buffer[] = [];
  let size = 0;
  let stopped = false;
  const stop = () => {
    stopped = true;
    parts = [];
    stream.removeAllListeners('data');
    stream.resume();
    onTooLarge();
  };
  stream.on('data', (chunk: Buffer) => {
    if (stopped) return;
    let start = 0;
    for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, start)) {
      const piece = chunk.subarray(start, nl);
      if (size + piece.length > max) return stop();
      parts.push(piece);
      const line = Buffer.concat(parts).toString('utf8');
      parts = [];
      size = 0;
      start = nl + 1;
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      if (stopped) return;
    }
    const rest = chunk.subarray(start);
    if (size + rest.length > max) return stop();
    if (rest.length) {
      parts.push(rest);
      size += rest.length;
    }
  });
  stream.on('end', () => {
    if (!stopped && size) onLine(Buffer.concat(parts).toString('utf8'));
  });
}
