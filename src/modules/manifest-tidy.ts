/**
 * Mechanical fixes to an AI-drafted manifest before it is checked: the mistakes models make most often and that have
 * one obvious correction, so a draft is not refused (or sent back to the AI three times) over a long description or a
 * URL where a host belongs. Nothing here widens what the module may do beyond what the draft itself declared, and
 * names the code refers to (action, setting and credential ids) are never changed. The reviewer sees the result.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Shortened to `max` characters, ending in "…" when cut. */
function cut(v: unknown, max: number): unknown {
  if (typeof v !== 'string') return v;
  const s = v.trim().replace(/\s+/g, ' ');
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** "https://API.github.com/v3/" -> "api.github.com"; a {{settings.x}} placeholder stays as it is. */
function host(v: unknown): unknown {
  if (typeof v !== 'string' || v.includes('{{')) return v;
  return v.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '').replace(/\.$/, '').toLowerCase();
}

const hosts = (v: unknown) => [...new Set(list(v).map(host))];

function tidyLabels(o: Obj): Obj {
  return { ...o, label: cut(o.label, 80), ...(o.help !== undefined ? { help: cut(o.help, 300) } : {}), ...(o.example !== undefined ? { example: cut(o.example, 120) } : {}) };
}

/**
 * A pattern as RE2 reads it: Dittoly checks every `pattern` with RE2 (linear time), which writes a code point as
 * \x{0041}, not JavaScript's \u0041 or \u{41}. Models write the JavaScript form; it means the same, so it is
 * rewritten. An escaped backslash ("\\u") is left alone.
 */
export function re2Pattern(p: string): string {
  return p.replace(/(?<!\\)((?:\\\\)*)\\u(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/g, (_m, bs: string, braced?: string, four?: string) => `${bs}\\x{${braced ?? four}}`);
}

/** Every `pattern` in a JSON Schema, in RE2's form (see re2Pattern). */
function tidySchema(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(tidySchema);
  if (!isObj(v)) return v;
  const out: Obj = {};
  for (const [k, val] of Object.entries(v)) out[k] = k === 'pattern' && typeof val === 'string' ? re2Pattern(val) : tidySchema(val);
  return out;
}

export function tidyManifest(value: unknown): unknown {
  let m = value;
  // { manifest: {...} } or { module: {...} } instead of the manifest itself.
  for (const key of ['manifest', 'module']) {
    if (isObj(m) && !('actions' in m) && isObj(m[key]) && 'actions' in (m[key] as Obj)) m = m[key];
  }
  if (!isObj(m)) return value;
  const out: Obj = { ...m };

  if (typeof out.name === 'string') {
    const name = out.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^[^a-z]+/, '').slice(0, 40).replace(/-+$/, '');
    if (name.length >= 2) out.name = name;
  }
  if (typeof out.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(out.version)) out.version = '1.0.0';
  out.title = cut(out.title, 80);
  if ((typeof out.description !== 'string' || !out.description.trim()) && typeof out.title === 'string') out.description = out.title;
  out.description = cut(out.description, 500);

  out.hosts = hosts(out.hosts);
  out.settings = list(out.settings).map((s) => (isObj(s) ? tidyLabels(s) : s));
  out.credentials = list(out.credentials).map((c) =>
    isObj(c) ? { ...tidyLabels(c), ...(typeof c.service === 'string' ? { service: c.service.toLowerCase() } : {}), hosts: hosts(c.hosts) } : c,
  );
  // A credential is only sent to the module's own hosts: one it names but the list misses is the module's host too.
  const declared = new Set([...(out.hosts as unknown[]), ...list(out.endpoints).map((e) => (isObj(e) ? e.host : null)), ...list(isObj(out.browser) ? out.browser.hosts : [])]);
  for (const c of out.credentials as unknown[]) {
    for (const h of isObj(c) ? list(c.hosts) : []) {
      if (typeof h === 'string' && !h.includes('{{') && !declared.has(h) && (out.hosts as unknown[]).length < 10) {
        (out.hosts as unknown[]).push(h);
        declared.add(h);
      }
    }
  }

  out.actions = list(out.actions).map((a) => {
    if (!isObj(a)) return a;
    const x: Obj = { ...a };
    if (typeof x.effect === 'string') x.effect = x.effect.toLowerCase();
    if ((typeof x.title !== 'string' || !x.title.trim()) && typeof x.name === 'string') x.title = x.name.replace(/_/g, ' ');
    x.title = cut(x.title, 80);
    if ((typeof x.description !== 'string' || !x.description.trim()) && typeof x.title === 'string') x.description = x.title;
    x.description = cut(x.description, 300);
    if (!Array.isArray(x.credentials)) x.credentials = typeof x.credentials === 'string' ? [x.credentials] : [];
    x.input = isObj(x.input) ? tidySchema(x.input) : { type: 'object', properties: {} };
    x.output = isObj(x.output) ? tidySchema(x.output) : { type: 'object' };
    // Only a write can be idempotent; on a read it is meaningless.
    if (x.effect !== 'write') delete x.idempotent;
    return x;
  });
  return out;
}
