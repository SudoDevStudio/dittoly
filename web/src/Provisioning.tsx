import { useState } from 'react';
import { api, post } from './api';
import { Card, Empty, ErrorText, Loading, useAction, useLoad, When } from './components';
import { Icon, Notice } from './ui';

/**
 * Provisioning (SCIM): the identity provider (Okta, Entra ID) creates, updates and offboards people and
 * pushes groups as teams. Admins create its token, link groups to teams, map groups to roles, and see
 * how syncing goes. See docs/scim.md.
 */

type Owned = Record<'flows' | 'schedules' | 'watches' | 'webhooks' | 'endpoints' | 'followups' | 'delegations', { id: string; name: string }[]>;
interface Overview {
  baseUrl: string;
  token: { id: string; createdAt: string; lastUsedAt: string | null } | null;
  lastSyncAt: string | null;
  users: { n: number; disabled: number };
  groups: { id: string; displayName: string; teamId: string; team: string; ownsTeam: boolean; grantsRole: 'admin' | 'approver' | null; members: number }[];
  errors: { at: string; method: string; resource: string; status: number; scimType: string | null; code: string }[];
  offboarded: { id: string; handle: string; displayName: string | null; at: string | null; deleted: boolean; owned: Owned }[];
}
interface Team { id: string; name: string }
interface MemberRow { id: string; handle: string; displayName: string | null; scim?: boolean; disabled: boolean }

const OWNED: [keyof Owned, string][] = [
  ['flows', 'Flows'],
  ['schedules', 'Schedules'],
  ['watches', 'Watches'],
  ['webhooks', 'Webhooks'],
  ['endpoints', 'Flow URLs'],
  ['followups', 'Follow-ups'],
  ['delegations', 'Pending delegations cancelled'],
];

export function ProvisioningCard() {
  const o = useLoad(() => api<Overview>('/admin/scim'));
  const teams = useLoad(() => api<Team[]>('/teams'));
  const members = useLoad(() => api<MemberRow[]>('/members'));
  const act = useAction();
  const [token, setToken] = useState<string | null>(null);
  const [link, setLink] = useState({ memberId: '', userName: '' });
  const reload = () => {
    o.reload();
    members.reload();
  };
  const configure = (groupId: string, body: object, done: string) => act.run(async () => (await api(`/admin/scim/groups/${groupId}`, { method: 'PUT', body }), reload()), done);
  if (!o.data) return <Card title={<><Icon name="users" />Provisioning (SCIM)</>}>{o.error ? <ErrorText>{o.error}</ErrorText> : <Loading />}</Card>;
  const d = o.data;
  const unlinked = (members.data ?? []).filter((m) => !m.scim && !m.disabled);
  return (
    <div id="provisioning">
      <Card title={<><Icon name="users" />Provisioning (SCIM)</>} actions={<span className="muted">{d.lastSyncAt ? <>last sync <When at={d.lastSyncAt} /></> : 'never synced'}</span>}>
        <p className="muted">
          Your identity provider (Okta, Microsoft Entra ID) creates people here, keeps their names and emails current, and offboards them: a deactivated or
          deleted person is disabled at once and their sessions, phones, API token and AI agents are revoked. Groups it pushes become teams. People still sign
          in with single sign-on. Setup steps are in <code>docs/scim.md</code>.
        </p>
        <div className="manifest-box">
          <span>SCIM BASE URL (TENANT URL)</span>
          <code>{d.baseUrl}</code>
          <span>TOKEN</span>
          <span>{d.token ? <>created <When at={d.token.createdAt} />{d.token.lastUsedAt ? <>, last used <When at={d.token.lastUsedAt} /></> : ', not used yet'}</> : 'none: create one and paste it into your identity provider'}</span>
          <span>PEOPLE</span>
          <span>{d.users.n} managed by the identity provider, {d.users.disabled} disabled</span>
        </div>
        <div className="row">
          <button className="primary" disabled={act.busy} onClick={() => act.run(async () => { setToken((await post<{ token: string }>('/admin/scim/token')).token); o.reload(); }, d.token ? 'Token rotated; the old one stopped working' : 'Token created')}>
            <Icon name="key" size={16} />{d.token ? 'Rotate token' : 'Create token'}
          </button>
          {d.token ? <button className="danger" disabled={act.busy} onClick={() => act.run(async () => { await api('/admin/scim/token', { method: 'DELETE' }); setToken(null); o.reload(); }, 'Token revoked; provisioning stopped')}>Revoke token</button> : null}
        </div>
        {token ? (
          <Notice icon="key">
            <strong>Save this token now.</strong> It is shown once; only a hash of it is stored. Paste it as the Secret Token (Entra ID) or the API token (Okta, "HTTP Header" authentication).
            <pre>{token}</pre>
            <button onClick={() => act.run(() => navigator.clipboard.writeText(token), 'Copied')}>Copy token</button>
          </Notice>
        ) : null}
        <ErrorText>{act.error}</ErrorText>
      </Card>

      <Card title={<><Icon name="layers" />Groups, teams and roles</>}>
        <p className="muted">
          Each group the identity provider pushes is a team; its members are that team's members. Link a group to an existing team instead, and map a group to a
          role: its members get that role while they are in it. A role you set by hand is never removed by a group, and the last enabled admin is never removed.
        </p>
        {d.groups.length ? (
          <div className="table-wrap">
            <table aria-label="SCIM groups">
              <thead><tr><th>Group</th><th>Team</th><th>Grants role</th><th>Members</th></tr></thead>
              <tbody>
                {d.groups.map((g) => (
                  <tr key={g.id}>
                    <td><strong>{g.displayName}</strong></td>
                    <td>
                      <select aria-label={`Team for ${g.displayName}`} value={g.teamId} disabled={act.busy || !teams.data} onChange={(e) => configure(g.id, { teamId: e.target.value }, 'Group linked to the team')}>
                        {(teams.data ?? [{ id: g.teamId, name: g.team }]).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                      {g.ownsTeam ? <span className="muted"> (made for this group)</span> : null}
                    </td>
                    <td>
                      <select aria-label={`Role for ${g.displayName}`} value={g.grantsRole ?? ''} disabled={act.busy} onChange={(e) => configure(g.id, { grantsRole: e.target.value || null }, 'Role mapping saved')}>
                        <option value="">no role (member)</option>
                        <option value="approver">approver</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td>{g.members}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Empty>No groups pushed yet.</Empty>}
      </Card>

      <Card title={<><Icon name="lock" />Link an existing account</>}>
        <p className="muted">
          Someone who signed in before provisioning started already has an account. Dittoly never matches it to the identity provider by email alone; link it
          here to their userName in the identity provider, and the provider will find and manage it instead of creating a second account.
        </p>
        <form className="row" onSubmit={(e) => { e.preventDefault(); act.run(async () => { await api(`/admin/scim/members/${link.memberId}/link`, { method: 'PUT', body: { userName: link.userName } }); setLink({ memberId: '', userName: '' }); reload(); }, 'Account linked'); }}>
          <label>Member<select value={link.memberId} onChange={(e) => setLink({ ...link, memberId: e.target.value })}><option value="">Choose…</option>{unlinked.map((m) => <option key={m.id} value={m.id}>{m.displayName ?? m.handle} ({m.handle})</option>)}</select></label>
          <label>userName in the identity provider<input value={link.userName} placeholder="name@company.com" onChange={(e) => setLink({ ...link, userName: e.target.value })} /></label>
          <button type="submit" disabled={act.busy || !link.memberId || !link.userName.trim()}>Link</button>
        </form>
      </Card>

      <Card title={<><Icon name="bell" />Offboarded by the identity provider</>}>
        <p className="muted">These people were deactivated or deleted. What ran as them stops working; give it a new owner or turn it off.</p>
        {d.offboarded.length ? (
          <ul className="list" aria-label="Offboarded people">
            {d.offboarded.map((m) => {
              const owned = OWNED.filter(([k]) => m.owned[k].length);
              return (
                <li key={m.id}>
                  <div>
                    <strong>{m.displayName ?? m.handle}</strong> <span className="muted">{m.handle} · {m.deleted ? 'deleted' : 'deactivated'} <When at={m.at} /></span>
                    {owned.length ? (
                      <ul>{owned.map(([k, label]) => <li key={k}>{label}: {m.owned[k].map((x) => x.name).join(', ')}</li>)}</ul>
                    ) : <div className="muted">Owned nothing that runs on its own.</div>}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : <Empty>Nobody has been offboarded.</Empty>}
      </Card>

      <Card title={<><Icon name="clock" />Recent sync errors</>}>
        {d.errors.length ? (
          <ul className="list" aria-label="SCIM errors">
            {d.errors.map((e, i) => (
              <li key={i}><span className="badge tone-danger">{e.status}</span> <code>{e.method} {e.resource}</code> {e.code.replace(/_/g, ' ')}{e.scimType ? <span className="muted"> ({e.scimType})</span> : null}<span className="muted"><When at={e.at} /></span></li>
            ))}
          </ul>
        ) : <Empty>No errors.</Empty>}
      </Card>
    </div>
  );
}
