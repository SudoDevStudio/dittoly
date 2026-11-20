import type { FlowDefinition } from '../flows/definition.js';
import type { Manifest } from './manifest.js';

/**
 * What changed between two versions, for the person approving the new one: the
 * manifest in plain sentences (what it may reach, which credentials, which actions
 * change data) and the code as a line diff.
 */

export interface LineChange {
  op: ' ' | '+' | '-';
  text: string;
}

const MAX_LINES = 4000;

/** A line diff (longest common subsequence), with unchanged runs trimmed to `context` lines around changes. */
export function lineDiff(before: string, after: string, context = 3): { lines: LineChange[]; added: number; removed: number; truncated: boolean } {
  let a = before.split('\n');
  let b = after.split('\n');
  const truncated = a.length > MAX_LINES || b.length > MAX_LINES;
  a = a.slice(0, MAX_LINES);
  b = b.slice(0, MAX_LINES);
  // Common prefix and suffix first: most new versions change a few lines.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) (endA--, endB--);
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  const ops: LineChange[] = [];
  if (n * m > 4_000_000) {
    // Too different to align cheaply: show it as replaced.
    for (const t of midA) ops.push({ op: '-', text: t });
    for (const t of midB) ops.push({ op: '+', text: t });
  } else {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = midA[i] === midB[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) (ops.push({ op: ' ', text: midA[i]! }), i++, j++);
      else if (i < n && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) (ops.push({ op: '-', text: midA[i]! }), i++);
      else (ops.push({ op: '+', text: midB[j]! }), j++);
    }
  }
  const all: LineChange[] = [...a.slice(0, start).map((text) => ({ op: ' ' as const, text })), ...ops, ...a.slice(endA).map((text) => ({ op: ' ' as const, text }))];
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((l, k) => {
    if (l.op !== ' ') for (let x = Math.max(0, k - context); x <= Math.min(all.length - 1, k + context); x++) keep[x] = true;
  });
  const lines: LineChange[] = [];
  let skipped = 0;
  all.forEach((l, k) => {
    if (keep[k]) {
      if (skipped) lines.push({ op: ' ', text: `… ${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
      skipped = 0;
      lines.push(l);
    } else skipped++;
  });
  if (skipped && lines.length) lines.push({ op: ' ', text: `… ${skipped} unchanged line${skipped === 1 ? '' : 's'}` });
  return { lines, added: ops.filter((o) => o.op === '+').length, removed: ops.filter((o) => o.op === '-').length, truncated };
}

const list = (xs: string[]) => xs.join(', ');
const setDiff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

/** Manifest changes, most important first (new reach and new data changes). */
export function manifestChanges(before: Manifest, after: Manifest): string[] {
  const out: string[] = [];
  const hostsA = [...before.hosts, ...(before.browser?.hosts ?? []), ...before.endpoints.map((e) => e.host)];
  const hostsB = [...after.hosts, ...(after.browser?.hosts ?? []), ...after.endpoints.map((e) => e.host)];
  const newHosts = setDiff([...new Set(hostsB)], hostsA);
  const goneHosts = setDiff([...new Set(hostsA)], hostsB);
  if (newHosts.length) out.push(`Now also reaches ${list(newHosts)}.`);
  if (goneHosts.length) out.push(`No longer reaches ${list(goneHosts)}.`);
  if (before.publicWeb !== after.publicWeb) out.push(after.publicWeb === 'read' ? 'May now read any public website.' : 'No longer reads arbitrary public websites.');
  const credsA = before.credentials.map((c) => c.service);
  const credsB = after.credentials.map((c) => c.service);
  if (setDiff(credsB, credsA).length) out.push(`Needs new credentials: ${list(setDiff(credsB, credsA))}.`);
  if (setDiff(credsA, credsB).length) out.push(`No longer uses: ${list(setDiff(credsA, credsB))}.`);
  for (const c of after.credentials) {
    const old = before.credentials.find((x) => x.service === c.service);
    if (!old) continue;
    if (!same(old.hosts, c.hosts)) out.push(`The ${c.service} credential is now sent to ${list(c.hosts)} (was ${list(old.hosts)}).`);
    if (!same(old.placement, c.placement)) out.push(`The ${c.service} credential is attached differently.`);
    const sa = (old as { scopes?: string[] }).scopes ?? [];
    const sb = (c as { scopes?: string[] }).scopes ?? [];
    if (!same(sa, sb)) out.push(`The ${c.service} token now needs scopes ${list(sb) || 'none declared'} (was ${list(sa) || 'none declared'}).`);
  }
  for (const act of after.actions) {
    const old = before.actions.find((x) => x.name === act.name);
    if (!old) {
      out.push(`New action "${act.title}"${act.effect === 'write' ? ', which changes data' : ' (read-only)'}.`);
      continue;
    }
    if (old.effect !== act.effect) out.push(act.effect === 'write' ? `"${act.title}" now changes data (was read-only).` : `"${act.title}" is now read-only.`);
    if (Boolean(old.idempotent) !== Boolean(act.idempotent)) out.push(act.idempotent ? `"${act.title}" is now repeated when its answer is lost (the module says a repeat changes nothing more).` : `"${act.title}" is no longer repeated when its answer is lost.`);
    if (!same(old.input, act.input)) out.push(`"${act.title}" takes different input.`);
    if (!same(old.output, act.output)) out.push(`"${act.title}" returns a different shape (Flows using it may need a look).`);
    if (!same(old.credentials, act.credentials)) out.push(`"${act.title}" uses different credentials.`);
  }
  for (const act of before.actions) if (!after.actions.some((x) => x.name === act.name)) out.push(`Action "${act.title}" was removed (Flows pinned to the old version keep working).`);
  if (!same(before.settings, after.settings)) out.push('Its organization settings changed.');
  return out;
}

/**
 * What a new version may reach or change that the old one could not: new hosts, reading any public
 * website, new credentials (or a credential sent to new hosts), new actions that change data, and
 * actions that went from reading to changing data. Empty when access stays the same or narrows.
 */
export function accessWidening(before: Manifest, after: Manifest): string[] {
  const out: string[] = [];
  const hosts = (m: Manifest) => [...m.hosts, ...(m.browser?.hosts ?? []), ...m.endpoints.map((e) => e.host)];
  const newHosts = setDiff([...new Set(hosts(after))], hosts(before));
  if (newHosts.length) out.push(`reaches new hosts: ${list(newHosts)}`);
  if (after.publicWeb === 'read' && before.publicWeb !== 'read') out.push('may read any public website');
  const newCreds = setDiff(after.credentials.map((c) => c.service), before.credentials.map((c) => c.service));
  if (newCreds.length) out.push(`uses new credentials: ${list(newCreds)}`);
  for (const c of after.credentials) {
    const old = before.credentials.find((x) => x.service === c.service);
    const more = old ? setDiff(c.hosts, old.hosts) : [];
    if (more.length) out.push(`sends the ${c.service} credential to new hosts: ${list(more)}`);
  }
  for (const act of after.actions) {
    if (act.effect !== 'write') continue;
    const old = before.actions.find((x) => x.name === act.name);
    if (!old) out.push(`new action "${act.title}" changes data`);
    else if (old.effect !== 'write') out.push(`"${act.title}" now changes data (was read-only)`);
  }
  return out;
}

/** Flow definition changes by step id. */
export function flowChanges(before: FlowDefinition, after: FlowDefinition): string[] {
  const out: string[] = [];
  const label = (s: { id: string; title?: string }) => `"${s.title ?? s.id}"`;
  for (const s of after.steps) {
    const old = before.steps.find((x) => x.id === s.id);
    if (!old) {
      out.push(`New step ${label(s)} (${s.type}${s.type === 'action' ? `: ${s.module} ${s.action}` : ''}).`);
      continue;
    }
    if (old.type !== s.type) {
      out.push(`Step ${label(s)} is now a ${s.type} step (was ${old.type}).`);
      continue;
    }
    if (s.type === 'action' && old.type === 'action') {
      if (old.module !== s.module) out.push(`Step ${label(s)} now uses ${s.module} (was ${old.module}).`);
      if (old.action !== s.action) out.push(`Step ${label(s)} now runs ${s.action} (was ${old.action}).`);
      if ((old.delegateTo ?? null) !== (s.delegateTo ?? null)) out.push(s.delegateTo ? `Step ${label(s)} is now handed to a teammate.` : `Step ${label(s)} is no longer handed to a teammate.`);
    }
    const { title: _t1, ...restOld } = old as Record<string, unknown>;
    const { title: _t2, ...restNew } = s as Record<string, unknown>;
    if (!same(restOld, restNew) && !out.some((l) => l.includes(label(s)))) out.push(`Step ${label(s)} changed.`);
    if ((old.title ?? old.id) !== (s.title ?? s.id)) out.push(`Step "${old.title ?? old.id}" is now called "${s.title ?? s.id}".`);
  }
  for (const s of before.steps) if (!after.steps.some((x) => x.id === s.id)) out.push(`Step ${label(s)} was removed.`);
  const order = (d: FlowDefinition) => d.steps.map((s) => s.id).join('>');
  if (order(before) !== order(after) && before.steps.length === after.steps.length && !out.length) out.push('Steps run in a different order.');
  if (!same(before.inputs, after.inputs)) out.push('The run form (inputs) changed.');
  return out;
}
