import { useState } from 'react';
import { api, post } from './api';
import { Card, Empty, ErrorText, Status, useAction, useLoad, When } from './components';
import { Icon } from './ui';

/**
 * Watches on a Flow page: start this Flow for each new item an app shows, each new
 * email, or each new file. The first look only remembers what is already there.
 */

interface Watch {
  id: string; name: string; kind: 'app' | 'email' | 'files'; flowVersionId: string; flow: string; config: Record<string, unknown>; inputs: Record<string, unknown>;
  intervalSeconds: number; enabled: boolean; disabledReason: string | null; primed: boolean; lastCheckedAt: string | null; lastError: string | null; runsStarted: number;
}
interface CatalogAction { module: string; moduleTitle: string; action: string; title: string; effect: string; input: { properties?: Record<string, unknown> }; output: { properties?: Record<string, { type?: string; items?: { properties?: Record<string, unknown> } }> } }

const KIND = { app: 'New items in an app', email: 'New emails', files: 'New files (S3-compatible)' } as const;
const VARS = { app: '{{ item.<field> }}', email: '{{ email.from }}, {{ email.subject }}, {{ email.text }}, {{ email.date }}', files: '{{ file.key }}, {{ file.size }}, {{ file.lastModified }}, {{ file.text }}' } as const;

export function WatchesCard({ flowVersionId, inputs }: { flowVersionId: string; inputs: unknown }) {
  const list = useLoad(() => api<Watch[]>('/watches'));
  const catalog = useLoad(() => api<CatalogAction[]>('/catalog'));
  const act = useAction();
  const [kind, setKind] = useState<'app' | 'email' | 'files' | ''>('');
  const [f, setF] = useState<Record<string, string>>({});
  const [map, setMap] = useState<Record<string, string>>({});
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const fields = Object.keys(((inputs ?? {}) as { properties?: Record<string, unknown> }).properties ?? {});
  const mine = (list.data ?? []).filter((w) => w.flowVersionId === flowVersionId);
  const reads = (catalog.data ?? []).filter((a) => a.effect === 'read');

  const create = () =>
    act.run(async () => {
      const common = { name: f.name ?? '', flowVersionId, inputs: Object.fromEntries(Object.entries(map).filter(([, v]) => v !== '')), intervalSeconds: Number(f.interval ?? 300) };
      let body: Record<string, unknown>;
      if (kind === 'app') {
        const [module, action] = (f.action ?? '').split('#');
        let actionInput = {};
        try { actionInput = f.actionInput ? JSON.parse(f.actionInput) : {}; } catch { throw new Error('The action input is not valid JSON.'); }
        body = { kind, ...common, module, action, actionInput, itemsPath: f.itemsPath ?? '', keyField: f.keyField ?? '' };
      } else if (kind === 'email') {
        body = { kind, ...common, host: f.host ?? '', port: Number(f.port ?? 993), secure: (f.secure ?? 'tls') === 'tls', user: f.user ?? '', password: f.password ?? '', mailbox: f.mailbox || 'INBOX', ...(f.from ? { fromContains: f.from } : {}), ...(f.subject ? { subjectContains: f.subject } : {}) };
      } else {
        body = { kind, ...common, endpoint: f.endpoint ?? '', region: f.region || 'us-east-1', bucket: f.bucket ?? '', prefix: f.prefix ?? '', accessKeyId: f.accessKeyId ?? '', secretAccessKey: f.secretAccessKey ?? '', includeText: f.includeText === 'yes' };
      }
      await post('/watches', body);
      setKind('');
      setF({});
      setMap({});
      list.reload();
    }, 'Watch added; its first look remembers what is already there');

  const chosen = reads.find((a) => `${a.module}#${a.action}` === f.action);
  return (
    <Card title={<><Icon name="eye" />Watches</>} actions={<span className="badge tone-info">{mine.length}</span>}>
      <p className="muted">Start this Flow for each new item an app shows, each new email, or each new file. The first look only remembers what is already there; then each new one starts a run as you (at most 20 per look).</p>
      {mine.length ? (
        <ul className="list" aria-label="Watches of this Flow">
          {mine.map((w) => (
            <li key={w.id}>
              <strong>{w.name}</strong> <span className="muted">{KIND[w.kind]} · every {Math.round(w.intervalSeconds / 60)} min · {w.runsStarted} run(s){w.lastCheckedAt ? <> · looked <When at={w.lastCheckedAt} /></> : ' · not looked yet'}</span>
              {w.lastError ? <span className="badge tone-danger" title="Last look failed">{w.lastError}</span> : null}
              {!w.enabled ? <Status value="cancelled" /> : null}
              <button disabled={act.busy} onClick={() => act.run(async () => { const r = await post<Watch>(`/watches/${w.id}/check`); list.reload(); return r; }, (r) => (r.lastError ? `Look failed: ${r.lastError}` : 'Looked'))}>Check now</button>
              <button className="ghost" disabled={act.busy} onClick={() => act.run(async () => (await api(`/watches/${w.id}`, { method: 'PATCH', body: { enabled: !w.enabled } }), list.reload()), w.enabled ? 'Watch turned off' : 'Watch turned on')}>{w.enabled ? 'Turn off' : 'Turn on'}</button>
              <button className="danger" disabled={act.busy} onClick={() => act.run(async () => (await api(`/watches/${w.id}`, { method: 'DELETE' }), list.reload()), 'Watch removed')}>Remove</button>
            </li>
          ))}
        </ul>
      ) : list.data ? <Empty>No watches for this version.</Empty> : null}
      <div className="field">
        <label htmlFor="watch-kind">Add a watch</label>
        <select id="watch-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="">Choose what to watch…</option>
          {Object.entries(KIND).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
      {kind ? (
        <div className="watch-form">
          <div className="field"><label htmlFor="watch-name">Name</label><input id="watch-name" value={f.name ?? ''} onChange={set('name')} /></div>
          {kind === 'app' ? (
            <>
              <div className="field">
                <label htmlFor="watch-action">Read action</label>
                <select id="watch-action" value={f.action ?? ''} onChange={set('action')}>
                  <option value="">Choose…</option>
                  {reads.map((a) => <option key={`${a.module}#${a.action}`} value={`${a.module}#${a.action}`}>{a.moduleTitle}: {a.title} ({a.module})</option>)}
                </select>
              </div>
              <div className="field"><label htmlFor="watch-action-input">Action input (JSON)</label><textarea id="watch-action-input" rows={2} value={f.actionInput ?? ''} placeholder={chosen ? JSON.stringify(Object.fromEntries(Object.keys(chosen.input.properties ?? {}).map((k) => [k, '…']))) : '{}'} onChange={set('actionInput')} /></div>
              <div className="row">
                <div className="field"><label htmlFor="watch-items">List in the result</label><input id="watch-items" value={f.itemsPath ?? ''} placeholder={Object.keys(chosen?.output.properties ?? {}).find((k) => chosen?.output.properties?.[k]?.type === 'array') ?? 'e.g. issues'} onChange={set('itemsPath')} /></div>
                <div className="field"><label htmlFor="watch-key">Field that tells items apart</label><input id="watch-key" value={f.keyField ?? ''} placeholder="e.g. id or key" onChange={set('keyField')} /></div>
              </div>
            </>
          ) : kind === 'email' ? (
            <>
              <div className="row">
                <div className="field"><label htmlFor="watch-host">IMAP server</label><input id="watch-host" value={f.host ?? ''} placeholder="imap.example.com" onChange={set('host')} /></div>
                <div className="field"><label htmlFor="watch-port">Port</label><input id="watch-port" className="narrow" type="number" value={f.port ?? '993'} onChange={set('port')} /></div>
                <div className="field"><label htmlFor="watch-tls">Encryption</label><select id="watch-tls" value={f.secure ?? 'tls'} onChange={set('secure')}><option value="tls">TLS (993)</option><option value="starttls">STARTTLS (143)</option></select></div>
              </div>
              <div className="row">
                <div className="field"><label htmlFor="watch-user">User</label><input id="watch-user" value={f.user ?? ''} onChange={set('user')} /></div>
                <div className="field"><label htmlFor="watch-password">Password or app password</label><input id="watch-password" type="password" autoComplete="new-password" value={f.password ?? ''} onChange={set('password')} /></div>
                <div className="field"><label htmlFor="watch-mailbox">Mailbox</label><input id="watch-mailbox" value={f.mailbox ?? ''} placeholder="INBOX" onChange={set('mailbox')} /></div>
              </div>
              <div className="row">
                <div className="field"><label htmlFor="watch-from">Only from (contains)</label><input id="watch-from" value={f.from ?? ''} onChange={set('from')} /></div>
                <div className="field"><label htmlFor="watch-subject">Only subjects containing</label><input id="watch-subject" value={f.subject ?? ''} onChange={set('subject')} /></div>
              </div>
              <p className="muted">The mailbox is only read: nothing is marked read, moved or deleted. The password is stored encrypted and never shown again.</p>
            </>
          ) : (
            <>
              <div className="row">
                <div className="field"><label htmlFor="watch-endpoint">Endpoint</label><input id="watch-endpoint" value={f.endpoint ?? ''} placeholder="https://s3.eu-central-1.amazonaws.com" onChange={set('endpoint')} /></div>
                <div className="field"><label htmlFor="watch-region">Region</label><input id="watch-region" className="narrow" value={f.region ?? ''} placeholder="us-east-1" onChange={set('region')} /></div>
              </div>
              <div className="row">
                <div className="field"><label htmlFor="watch-bucket">Bucket</label><input id="watch-bucket" value={f.bucket ?? ''} onChange={set('bucket')} /></div>
                <div className="field"><label htmlFor="watch-prefix">Folder (prefix)</label><input id="watch-prefix" value={f.prefix ?? ''} placeholder="incoming/" onChange={set('prefix')} /></div>
              </div>
              <div className="row">
                <div className="field"><label htmlFor="watch-akid">Access key ID</label><input id="watch-akid" value={f.accessKeyId ?? ''} onChange={set('accessKeyId')} /></div>
                <div className="field"><label htmlFor="watch-secret">Secret access key</label><input id="watch-secret" type="password" autoComplete="new-password" value={f.secretAccessKey ?? ''} onChange={set('secretAccessKey')} /></div>
              </div>
              <label className="check"><input type="checkbox" checked={f.includeText === 'yes'} onChange={(e) => setF((x) => ({ ...x, includeText: e.target.checked ? 'yes' : '' }))} />Give the Flow the text of small text files (up to 256 KB)</label>
              <p className="muted">Use a key that may only list and read this bucket.</p>
            </>
          )}
          <fieldset className="field">
            <legend>Flow inputs (you can use {VARS[kind]})</legend>
            {fields.length ? fields.map((name) => (
              <div className="field" key={name}><label htmlFor={`watch-in-${name}`}>{name}</label><input id={`watch-in-${name}`} value={map[name] ?? ''} onChange={(e) => setMap((m) => ({ ...m, [name]: e.target.value }))} /></div>
            )) : <p className="muted">This Flow takes no inputs.</p>}
          </fieldset>
          <div className="row">
            <div className="field"><label htmlFor="watch-interval">Look every</label><select id="watch-interval" value={f.interval ?? '300'} onChange={set('interval')}><option value="60">minute</option><option value="300">5 minutes</option><option value="900">15 minutes</option><option value="3600">hour</option></select></div>
          </div>
          <div className="row">
            <button className="primary" disabled={act.busy || !f.name} onClick={create}>Add watch</button>
            <button onClick={() => setKind('')}>Cancel</button>
          </div>
        </div>
      ) : null}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}
