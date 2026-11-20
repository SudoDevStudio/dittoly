import { useState, type ReactNode } from 'react';
import { Pre } from './components';
import { LinkOrMedia } from './MediaEmbed';

/**
 * A step's output, readable: lists of records as a table, objects as labelled
 * fields, with the template path of each field to copy into a later step
 * ({{ steps.<id>.output.<field> }}, or {{ item.<field> }} inside forEach).
 * "Raw JSON" shows the exact value.
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const isRecord = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);
const MAX_ROWS = 50;
const MAX_COLUMNS = 8;

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

function PathChip({ path }: { path: string }) {
  const [done, setDone] = useState(false);
  const text = `{{ ${path} }}`;
  return (
    <button
      type="button"
      className="path-chip"
      title={`Copy ${text} to use this value in a later step`}
      onClick={() => {
        copy(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? 'copied' : path}
    </button>
  );
}

function Scalar({ v }: { v: Json }) {
  if (v === null) return <span className="muted">null</span>;
  if (typeof v === 'boolean') return <code>{String(v)}</code>;
  if (typeof v === 'number') return <code>{v}</code>;
  if (typeof v === 'string') {
    // Links play or show inline when they are media from an allowed source (see media.ts).
    if (/^https?:\/\/\S+$/.test(v)) return <LinkOrMedia url={v} />;
    // Screenshots from browser scripts arrive as image data URLs.
    if (/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+=*$/.test(v)) return <img className="out-shot" src={v} alt="Screenshot from the browser" loading="lazy" />;
    return <span className="out-text">{v}</span>;
  }
  const text = JSON.stringify(v);
  return <code title={text}>{text.length > 80 ? `${text.slice(0, 80)}…` : text}</code>;
}

function RecordTable({ rows, path }: { rows: Record<string, Json>[]; path: string }) {
  const [all, setAll] = useState(false);
  const columns: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  const shown = columns.slice(0, MAX_COLUMNS);
  const visible = all ? rows : rows.slice(0, MAX_ROWS);
  return (
    <div>
      <p className="muted out-meta">
        {rows.length} {rows.length === 1 ? 'item' : 'items'} · run a later step once per item with <PathChip path={path} /> as its forEach, then use the
        column paths below
      </p>
      <div className="table-wrap">
        <table className="out-table">
          <thead>
            <tr>
              {shown.map((c) => (
                <th key={c}>
                  <PathChip path={`item.${c}`} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => (
              <tr key={i}>
                {shown.map((c) => (
                  <td key={c}>{r[c] === undefined ? null : <Scalar v={r[c]!} />}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {columns.length > MAX_COLUMNS ? <p className="muted out-meta">{columns.length - MAX_COLUMNS} more fields in Raw JSON.</p> : null}
      {rows.length > MAX_ROWS && !all ? (
        <button type="button" className="ghost" onClick={() => setAll(true)}>
          Show all {rows.length}
        </button>
      ) : null}
    </div>
  );
}

function Node({ v, path, depth }: { v: Json; path: string; depth: number }): ReactNode {
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="muted">empty list</span>;
    if (v.every(isRecord)) return <RecordTable rows={v} path={path} />;
    return (
      <ul className="out-list">
        {v.slice(0, MAX_ROWS).map((x, i) => (
          <li key={i}>
            <Node v={x} path={`${path}`} depth={depth + 1} />
          </li>
        ))}
        {v.length > MAX_ROWS ? <li className="muted">…{v.length - MAX_ROWS} more in Raw JSON</li> : null}
      </ul>
    );
  }
  if (isRecord(v)) {
    const entries = Object.entries(v);
    if (entries.length === 0) return <span className="muted">empty</span>;
    return (
      <dl className="out-fields">
        {entries.map(([k, x]) => {
          const p = `${path}.${k}`;
          const nested = Array.isArray(x) || isRecord(x);
          return (
            <div key={k} className="out-field">
              <dt>
                <strong>{k}</strong> <PathChip path={p} />
                {Array.isArray(x) ? <span className="muted"> · {x.length} items</span> : null}
              </dt>
              <dd>
                {nested && depth >= 2 ? (
                  <details>
                    <summary>show</summary>
                    <Node v={x} path={p} depth={depth + 1} />
                  </details>
                ) : (
                  <Node v={x} path={p} depth={depth + 1} />
                )}
              </dd>
            </div>
          );
        })}
      </dl>
    );
  }
  return <Scalar v={v} />;
}

/** `path` is the template path of the value itself, e.g. steps.<id>.output, or inputs. */
export function OutputView({ value, path }: { value: unknown; path: string }) {
  const [raw, setRaw] = useState(false);
  const json = JSON.stringify(value, null, 2);
  return (
    <div className="output-view">
      <div className="row out-tools">
        <div className="tabs" role="tablist" aria-label="Output format">
          <button type="button" role="tab" aria-selected={!raw} className={!raw ? 'selected' : undefined} onClick={() => setRaw(false)}>
            Readable
          </button>
          <button type="button" role="tab" aria-selected={raw} className={raw ? 'selected' : undefined} onClick={() => setRaw(true)}>
            Raw JSON
          </button>
        </div>
        <button type="button" className="ghost" onClick={() => copy(json)}>
          Copy JSON
        </button>
      </div>
      {raw ? <Pre>{json}</Pre> : <Node v={value as Json} path={path} depth={0} />}
    </div>
  );
}
