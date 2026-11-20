import { useState } from 'react';
import { api } from './api';
import { Card, ErrorText, Loading, useAction, useLoad } from './components';
import { Icon, InfoTip } from './ui';

/**
 * Git sync for one scope: the organization (teamId null) or a team. Approved modules, Flows, Super Flows and apps
 * are written to the connected repository as pull requests (src/git-sync/service.ts). Shown to the people who
 * manage the scope: org admins, or the team's admins.
 */
interface GitExport { id: string; kind: string; title: string; status: string; branch: string | null; url: string | null; error: string | null; createdAt: string }
interface GitImport { id: string; commit: string | null; status: 'imported' | 'failed'; created: { kind: string; name: string; version: string | number }[]; problems: string[]; createdAt: string }
interface Connection { id: string; teamId: string | null; provider: 'github' | 'gitlab' | 'git'; repoUrl: string; branch: string; folder: string; updatedAt: string; lastImportAt: string | null; exports: GitExport[]; imports: GitImport[] }

const PROVIDERS = { github: 'GitHub', gitlab: 'GitLab', git: 'Other git host (HTTPS)' } as const;
const TONE: Record<string, string> = { pending: 'info', opened: 'ok', pushed: 'ok', unchanged: 'muted', failed: 'bad' };
const STATUS: Record<string, string> = { pending: 'Writing…', opened: 'Pull request opened', pushed: 'Branch pushed', unchanged: 'Already up to date', failed: 'Failed' };

export function GitSyncCard({ teamId, teamName }: { teamId: string | null; teamName?: string }) {
  const q = teamId ? `?team=${teamId}` : '';
  const conn = useLoad(() => api<Connection | null>(`/git-connection${q}`), [teamId]);
  const act = useAction();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ provider: 'github' as Connection['provider'], repoUrl: '', branch: 'main', folder: 'dittoly', token: '' });
  const c = conn.data;
  const scope = teamId ? `${teamName ?? 'This team'}'s` : "The organization's";

  const startEdit = () => {
    setForm({ provider: c?.provider ?? 'github', repoUrl: c?.repoUrl ?? '', branch: c?.branch ?? 'main', folder: c?.folder ?? 'dittoly', token: '' });
    setEditing(true);
  };
  const save = () => act.run(async () => {
    await api('/git-connection', { method: 'PUT', body: { teamId, provider: form.provider, repoUrl: form.repoUrl.trim(), branch: form.branch.trim(), folder: form.folder.trim(), ...(form.token ? { token: form.token } : {}) } });
    setEditing(false);
    conn.reload();
  }, 'Repository connected');

  return (
    <Card title={<><Icon name="refresh" />{teamId ? `${teamName ?? 'Team'}: git` : 'Git sync'}</>} actions={c && !editing ? <span className="badge tone-info">{PROVIDERS[c.provider]}</span> : null}>
      <p className="muted">
        {teamId
          ? "Approved Flows, Super Flows and apps of this team go to its own repository. Without one, they go to the organization's. "
          : "Approved modules, Flows, Super Flows and apps are written to this repository as pull requests, for review and history. A team can connect its own repository for its Flows and apps. "}
        Approvals, run history and secrets are never written.
      </p>
      {conn.error && !/forbidden|admin_only|team_admin_only/.test(conn.error) ? <ErrorText>{conn.error}</ErrorText> : null}
      {conn.loading && !c ? <Loading /> : null}
      {!editing && c ? (
        <>
          <p>{scope} repository: <a href={c.repoUrl} target="_blank" rel="noopener noreferrer"><code>{c.repoUrl}</code></a>, branch <code>{c.branch}</code>, folder <code>{c.folder}/</code>.</p>
          <div className="row">
            <button type="button" className="primary" disabled={act.busy} onClick={() => act.run(async () => { await api(`/git-connections/${c.id}/export-all`, { method: 'POST' }); conn.reload(); }, 'Writing everything approved; a pull request follows shortly')}>Export everything approved now</button>
            <button type="button" disabled={act.busy} onClick={() => act.run(async () => { await api(`/git-connections/${c.id}/sync`, { method: 'POST' }); conn.reload(); }, 'Reading the branch; merged changes appear below shortly')}>Sync from git now</button>
            <button type="button" disabled={act.busy} onClick={startEdit}>Change</button>
            <button type="button" className="danger" disabled={act.busy} onClick={() => { if (confirm('Disconnect this repository? Nothing more is written to it.')) act.run(async () => { await api(`/git-connections/${c.id}`, { method: 'DELETE' }); conn.reload(); }, 'Repository disconnected'); }}>Disconnect</button>
            <button type="button" className="ghost" onClick={() => conn.reload()}>Refresh</button>
          </div>
          {c.exports.length ? (
            <div className="table-wrap"><table><thead><tr><th>What</th><th>Status</th><th>Where</th><th /></tr></thead><tbody>
              {c.exports.map((e) => (
                <tr key={e.id}>
                  <td>{e.title}<br /><span className="muted">{new Date(e.createdAt).toLocaleString()}</span></td>
                  <td><span className={`badge tone-${TONE[e.status] ?? 'muted'}`}>{STATUS[e.status] ?? e.status}</span>{e.error ? <><br /><span className="muted">{e.error}</span></> : null}</td>
                  <td>{e.url ? <a href={e.url} target="_blank" rel="noopener noreferrer">Open pull request</a> : e.branch ? <code>{e.branch}</code> : null}</td>
                  <td>{e.status === 'failed' ? <button type="button" disabled={act.busy} onClick={() => act.run(async () => { await api(`/git-exports/${e.id}/retry`, { method: 'POST' }); conn.reload(); })}>Retry</button> : null}</td>
                </tr>
              ))}
            </tbody></table></div>
          ) : <p className="muted">Nothing written yet. The next approval opens a pull request, or export everything approved now.</p>}
          <h3>From git</h3>
          <p className="muted">Changes merged into <code>{c.branch}</code> come back as new versions that wait for approval here; git never approves anything. The branch is read every 10 minutes{c.lastImportAt ? `, last at ${new Date(c.lastImportAt).toLocaleString()}` : ''}.</p>
          {c.imports.length ? (
            <ul className="list">
              {c.imports.map((i) => (
                <li key={i.id}>
                  <span className={`badge tone-${i.status === 'failed' ? 'bad' : i.problems.length ? 'warn' : 'ok'}`}>{i.status === 'failed' ? 'Could not read' : `${i.created.length} waiting for approval`}</span>{' '}
                  <span className="muted">{new Date(i.createdAt).toLocaleString()}{i.commit ? ` · ${i.commit.slice(0, 8)}` : ''}</span>
                  {i.created.length ? <div>{i.created.map((x) => `${x.kind === 'module' ? 'Module' : x.kind === 'flow' ? 'Flow' : 'App'} ${x.name} v${x.version}`).join(', ')}</div> : null}
                  {i.problems.length ? <ul>{i.problems.map((p) => <li key={p} className="muted">{p}</li>)}</ul> : null}
                </li>
              ))}
            </ul>
          ) : <p className="muted">Nothing has come from git yet.</p>}
        </>
      ) : null}
      {!editing && !c && !conn.loading && !conn.error ? (
        <div className="row"><button type="button" className="primary" onClick={startEdit}><Icon name="plus" size={16} />Connect a repository</button></div>
      ) : null}
      {editing ? (
        <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div className="field">
            <label htmlFor={`git-provider-${teamId ?? 'org'}`}>Host</label>
            <select id={`git-provider-${teamId ?? 'org'}`} value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value as Connection['provider'] })}>
              {Object.entries(PROVIDERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <div className="label-row"><label htmlFor={`git-url-${teamId ?? 'org'}`}>Repository URL</label><InfoTip label="Repository URL" text="The HTTPS address of the repository, as you would clone it. GitHub Enterprise and self-managed GitLab work too." example="https://github.com/acme/automations" /></div>
            <input id={`git-url-${teamId ?? 'org'}`} required value={form.repoUrl} placeholder="https://github.com/acme/automations" onChange={(e) => setForm({ ...form, repoUrl: e.target.value })} />
          </div>
          <div className="field">
            <div className="label-row"><label htmlFor={`git-branch-${teamId ?? 'org'}`}>Branch</label><InfoTip label="Branch" text="The branch pull requests go into." example="main" /></div>
            <input id={`git-branch-${teamId ?? 'org'}`} required value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
          </div>
          <div className="field">
            <div className="label-row"><label htmlFor={`git-folder-${teamId ?? 'org'}`}>Folder</label><InfoTip label="Folder" text="Where in the repository Dittoly writes: modules/, flows/ and apps/ go under it." example="dittoly" /></div>
            <input id={`git-folder-${teamId ?? 'org'}`} required value={form.folder} onChange={(e) => setForm({ ...form, folder: e.target.value })} />
          </div>
          <div className="field">
            <div className="label-row"><label htmlFor={`git-token-${teamId ?? 'org'}`}>Access token</label><InfoTip label="Access token" text="A token that can push branches and open pull requests: on GitHub a fine-grained token with Contents and Pull requests (read and write); on GitLab a project token with the api scope. It is encrypted and never shown again." example="github_pat_11A…" /></div>
            <input id={`git-token-${teamId ?? 'org'}`} type="password" autoComplete="off" value={form.token} placeholder={c ? 'Leave empty to keep the stored token' : ''} required={!c} onChange={(e) => setForm({ ...form, token: e.target.value })} />
          </div>
          <div className="row">
            <button type="submit" className="primary" disabled={act.busy}>{act.busy ? 'Checking the repository…' : c ? 'Save' : 'Connect'}</button>
            <button type="button" className="ghost" onClick={() => setEditing(false)}>Cancel</button>
          </div>
          {form.provider === 'git' ? <p className="muted">Other hosts get a branch pushed; open the pull request there.</p> : null}
        </form>
      ) : null}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}
