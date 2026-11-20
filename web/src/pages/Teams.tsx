import { useEffect, useState } from 'react';
import { GitSyncCard } from '../GitSync';
import { TeamTablesCard } from '../Tables';
import { api, post } from '../api';
import { Card, Empty, ErrorText, Loading, Page, useAction, useLoad, When } from '../components';
import { useMe } from '../context';
import { useTeams, type Team } from '../teams';
import { EgressCard } from '../Governance';
import { Icon, Notice } from '../ui';

interface TeamMember { id: string; handle: string; displayName: string | null; role: 'admin' | 'member' }
interface Person { id: string; handle: string; displayName: string | null }

/** Teams: who is in each, with which role. Org admins create teams; team admins manage their members. */
export function TeamsPage() {
  const { me } = useMe();
  const { teams, reload } = useTeams();
  const [selected, setSelected] = useState<string>('');
  const [name, setName] = useState('');
  const act = useAction();
  const team = teams.find((t) => t.id === selected) ?? teams[0];
  // Sent here by a Flow that cannot run for want of the team's credential: say which one, where it is stored.
  const wantedCredential = new URLSearchParams(location.search).get('credential');
  return (
    <Page title="Teams" eyebrow="WORKSPACE / TEAMS" description="Flows belong to a team. Its members see and run them; team admins manage the team. Modules are shared by the whole organization." className="teams-page">
      <div className="grid">
        <Card title={<><Icon name="users" />Your teams</>}>
          {teams.length === 0 ? (
            <Empty>You are not in any team yet.</Empty>
          ) : (
            <ul className="list team-list">
              {teams.map((t) => (
                <li key={t.id}>
                  <button type="button" className={`ghost ${team?.id === t.id ? 'selected' : ''}`} aria-pressed={team?.id === t.id} onClick={() => setSelected(t.id)}>
                    {t.name}
                  </button>
                  <span className="muted">
                    {t.members} {t.members === 1 ? 'member' : 'members'}
                    {t.isDefault ? ' · new members join it' : ''}
                  </span>
                  {t.myRole ? <span className={`badge ${t.myRole === 'admin' ? 'tone-info' : 'tone-muted'}`}>{t.myRole}</span> : null}
                </li>
              ))}
            </ul>
          )}
          {me.role === 'admin' ? (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                act.run(async () => {
                  const created = await post<{ id: string }>('/teams', { name });
                  setName('');
                  setSelected(created.id);
                  reload();
                }, 'Team created');
              }}
            >
              <div className="field">
                <label htmlFor="team-name">New team</label>
                <input id="team-name" value={name} maxLength={60} placeholder="Payments" onChange={(e) => setName(e.target.value)} />
              </div>
              <button type="submit" className="primary" disabled={act.busy || !name.trim()}>
                Create team
              </button>
            </form>
          ) : null}
          <ErrorText>{act.error}</ErrorText>
        </Card>
        {team ? <TeamMembers key={team.id} team={team} canManage={me.role === 'admin' || team.myRole === 'admin'} onChange={reload} /> : null}
      </div>
      {team ? <TeamCredentials key={`c-${team.id}`} team={team} canManage={me.role === 'admin' || team.myRole === 'admin'} wanted={wantedCredential} /> : null}
      {team ? <TeamChannels key={`n-${team.id}`} team={team} canManage={me.role === 'admin' || team.myRole === 'admin'} /> : null}
      {team ? <TeamTablesCard key={`t-${team.id}`} team={team} canManage={me.role === 'admin' || team.myRole === 'admin'} /> : null}
      {team ? <TeamDecisionsCard key={`d-${team.id}`} team={team} /> : null}
      {team && (me.role === 'admin' || team.myRole === 'admin') ? <GitSyncCard key={`g-${team.id}`} teamId={team.id} teamName={team.name} /> : null}
      {team && me.role === 'admin' ? <TeamRunLimit key={`r-${team.id}`} team={team} onChange={reload} /> : null}
      {team && (me.role === 'admin' || team.myRole === 'admin') ? <EgressCard key={`e-${team.id}`} teamId={team.id} /> : null}
    </Page>
  );
}

function TeamMembers({ team, canManage, onChange }: { team: Team; canManage: boolean; onChange: () => void }) {
  const members = useLoad(() => api<TeamMember[]>(`/teams/${team.id}/members`), [team.id]);
  const people = useLoad(() => (canManage ? api<Person[]>('/directory') : Promise.resolve([])), [canManage]);
  const act = useAction();
  const [adding, setAdding] = useState('');
  const change = (fn: () => Promise<unknown>) =>
    act.run(async () => {
      await fn();
      members.reload();
      onChange();
    }, 'Saved');
  const outside = people.data?.filter((p) => !members.data?.some((m) => m.id === p.id)) ?? [];
  return (
    <Card title={`${team.name}: members`}>
      {!members.data ? (
        <Loading />
      ) : (
        <ul className="list">
          {members.data.map((m) => (
            <li key={m.id}>
              <strong>{m.displayName ?? m.handle}</strong>
              <span className="muted">@{m.handle}</span>
              {canManage ? (
                <>
                  <select aria-label={`Role of ${m.handle}`} value={m.role} disabled={act.busy} onChange={(e) => change(() => api(`/teams/${team.id}/members/${m.id}`, { method: 'PUT', body: { role: e.target.value } }))}>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                  <button type="button" className="ghost" disabled={act.busy} onClick={() => change(() => api(`/teams/${team.id}/members/${m.id}`, { method: 'DELETE' }))}>
                    Remove
                  </button>
                </>
              ) : (
                <span className={`badge ${m.role === 'admin' ? 'tone-info' : 'tone-muted'}`}>{m.role}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <div className="row">
          <select aria-label="Add a member" value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Add a member…</option>
            {outside.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName ?? p.handle}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary"
            disabled={!adding || act.busy}
            onClick={() =>
              change(async () => {
                await api(`/teams/${team.id}/members/${adding}`, { method: 'PUT', body: { role: 'member' } });
                setAdding('');
              })
            }
          >
            Add
          </button>
        </div>
      ) : null}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

interface TeamCredential { module: string; moduleTitle: string; service: string; label: string; placement: string; mode: 'personal' | 'team'; teamStored: boolean }

/** Per module credential: each member's own account (personal) or one shared account the team stores (team). */
function TeamCredentials({ team, canManage, wanted }: { team: Team; canManage: boolean; wanted?: string | null }) {
  const list = useLoad(() => api<TeamCredential[]>(`/teams/${team.id}/credentials`), [team.id]);
  const act = useAction();
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  // Sent here by a Flow waiting for this team's credential: bring the card into view, where it is marked out.
  useEffect(() => {
    if (wanted) document.getElementById('team-credentials')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [wanted]);
  const change = (fn: () => Promise<unknown>) =>
    act.run(async () => {
      await fn();
      list.reload();
    }, 'Saved');
  return (
    <Card id="team-credentials" className={wanted ? 'wanted' : undefined} title={<><Icon name="key" />{team.name}: credentials</>}>
      {wanted ? (
        <Notice>
          <strong>A Flow is waiting for the team&apos;s <code>{wanted}</code>.</strong> Find it in the list below, set it to <strong>Team</strong>, and store the secret here. If
          each member should use their own account instead, leave it on <strong>Personal</strong> and they add it in their own credentials.
        </Notice>
      ) : null}
      <p className="muted">
        <strong>Personal</strong>: each member uses their own account, as in their vault. <strong>Team</strong>: everyone&apos;s runs in this team use one
        shared account stored here (encrypted, never shown again). Runs record when the team&apos;s account was used.
      </p>
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <Empty>No approved module asks for a credential yet.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Module</th>
                <th>Credential</th>
                <th>Whose access</th>
                <th>Team account</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((c) => {
                const key = `${c.module}:${c.service}`;
                return (
                  <tr key={key}>
                    <td>{c.moduleTitle}</td>
                    <td>
                      {c.label} <span className="muted">({c.service})</span>
                    </td>
                    <td>
                      {canManage ? (
                        <select
                          aria-label={`Whose access for ${c.moduleTitle} ${c.service}`}
                          value={c.mode}
                          disabled={act.busy}
                          onChange={(e) => change(() => api(`/teams/${team.id}/credential-modes`, { method: 'PUT', body: { module: c.module, service: c.service, mode: e.target.value } }))}
                        >
                          <option value="personal">Personal</option>
                          <option value="team">Team</option>
                        </select>
                      ) : (
                        <span className="badge tone-muted">{c.mode}</span>
                      )}
                    </td>
                    <td>
                      {c.mode === 'team' ? (
                        <div className="row">
                          {c.teamStored ? <span className="badge tone-ok">Stored</span> : <span className="badge tone-warn">Not set</span>}
                          {canManage ? (
                            <>
                              <input
                                type="password"
                                autoComplete="off"
                                aria-label={`Team secret for ${c.service}`}
                                placeholder={c.teamStored ? 'Replace…' : 'Secret'}
                                value={secrets[key] ?? ''}
                                onChange={(e) => setSecrets({ ...secrets, [key]: e.target.value })}
                              />
                              <button
                                type="button"
                                disabled={!secrets[key] || act.busy}
                                onClick={() =>
                                  change(async () => {
                                    await api(`/teams/${team.id}/credentials/${c.service}`, { method: 'PUT', body: { secret: secrets[key] } });
                                    setSecrets({ ...secrets, [key]: '' });
                                  })
                                }
                              >
                                Save
                              </button>
                              {c.teamStored ? (
                                <button type="button" className="ghost" disabled={act.busy} onClick={() => change(() => api(`/teams/${team.id}/credentials/${c.service}`, { method: 'DELETE' }))}>
                                  Remove
                                </button>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      ) : (
                        <span className="muted">Each member&apos;s own</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

interface Channel { id: string; name: string; module: string; action: string; input: Record<string, unknown>; enabled: boolean }
interface CatalogAction { module: string; moduleTitle: string; action: string; title: string; effect: string; input: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] } }

/** A sensible starting template for an input, from its name. */
function suggest(name: string): string {
  const n = name.toLowerCase();
  if (/(^|_)(to|email|recipient)s?$/.test(n)) return '{{ member.email }}';
  if (/subject|title/.test(n)) return 'Dittoly: {{ message.text }}';
  if (/text|message|body|content|description/.test(n)) return '{{ message.text }} {{ message.url }}';
  return '';
}

/**
 * The team's own notification channels: an approved module action run with the
 * team's shared credentials. Where a team has any, they replace the server's
 * Slack/Teams/email settings for notifications about its runs.
 */
function TeamChannels({ team, canManage }: { team: Team; canManage: boolean }) {
  const list = useLoad(() => api<Channel[]>(`/teams/${team.id}/channels`), [team.id]);
  const catalog = useLoad(() => (canManage ? api<CatalogAction[]>('/catalog') : Promise.resolve([])), [canManage]);
  const act = useAction();
  const [pick, setPick] = useState('');
  const [name, setName] = useState('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const chosen = catalog.data?.find((a) => `${a.module} ${a.action}` === pick);
  const props = Object.entries(chosen?.input.properties ?? {});
  const change = (fn: () => Promise<unknown>) =>
    act.run(async () => {
      await fn();
      list.reload();
    }, 'Saved');
  return (
    <Card title={<><Icon name="bell" />{team.name}: notification channels</>}>
      <p className="muted">
        Notifications about this team&apos;s runs (approvals, paused or failed runs, delegations) go through these channels instead of the server&apos;s
        Slack, Teams and email settings. Each channel runs a module action with the team&apos;s shared credentials, once per person notified. Use{' '}
        <code>{'{{ message.text }}'}</code>, <code>{'{{ message.url }}'}</code>, <code>{'{{ message.kind }}'}</code>, <code>{'{{ member.email }}'}</code>,{' '}
        <code>{'{{ member.name }}'}</code> and <code>{'{{ member.handle }}'}</code> in its inputs. Messages never contain run data.
      </p>
      {!list.data ? (
        <Loading />
      ) : list.data.length === 0 ? (
        <Empty>No channels: the server&apos;s Slack, Teams and email settings are used.</Empty>
      ) : (
        <ul className="list">
          {list.data.map((c) => (
            <li key={c.id}>
              <strong>{c.name}</strong>
              <span className="muted">
                {c.module} · {c.action}
              </span>
              <span className={`badge ${c.enabled ? 'tone-ok' : 'tone-muted'}`}>{c.enabled ? 'on' : 'off'}</span>
              {canManage ? (
                <>
                  <button
                    type="button"
                    disabled={act.busy}
                    onClick={() =>
                      change(async () => {
                        setNotice(null);
                        await post(`/teams/${team.id}/channels/${c.id}/test`);
                        setNotice(`Sent a test message through ${c.name}.`);
                      })
                    }
                  >
                    Send test
                  </button>
                  <button type="button" className="ghost" disabled={act.busy} onClick={() => change(() => api(`/teams/${team.id}/channels/${c.id}`, { method: 'PATCH', body: { enabled: !c.enabled } }))}>
                    {c.enabled ? 'Turn off' : 'Turn on'}
                  </button>
                  <button type="button" className="ghost" disabled={act.busy} onClick={() => change(() => api(`/teams/${team.id}/channels/${c.id}`, { method: 'DELETE' }))}>
                    Remove
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {notice ? <p className="muted" role="status">{notice}</p> : null}
      {canManage ? (
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            if (!chosen) return;
            const input: Record<string, unknown> = {};
            for (const [k, p] of props) {
              const v = inputs[k] ?? '';
              if (v === '') continue;
              input[k] = p.type === 'number' || p.type === 'integer' ? Number(v) : p.type === 'boolean' ? v === 'true' : v;
            }
            change(async () => {
              await post(`/teams/${team.id}/channels`, { name: name.trim() || chosen.title, module: chosen.module, action: chosen.action, input });
              setPick('');
              setName('');
              setInputs({});
            });
          }}
        >
          <div className="field">
            <label htmlFor="channel-action">Add a channel: module action</label>
            <select
              id="channel-action"
              value={pick}
              onChange={(e) => {
                setPick(e.target.value);
                const a = catalog.data?.find((x) => `${x.module} ${x.action}` === e.target.value);
                setInputs(Object.fromEntries(Object.keys(a?.input.properties ?? {}).map((k) => [k, suggest(k)])));
              }}
            >
              <option value="">Choose…</option>
              {catalog.data?.map((a) => (
                <option key={`${a.module} ${a.action}`} value={`${a.module} ${a.action}`}>
                  {a.moduleTitle}: {a.title} ({a.module})
                </option>
              ))}
            </select>
          </div>
          {chosen ? (
            <>
              <div className="field">
                <label htmlFor="channel-name">Name</label>
                <input id="channel-name" value={name} placeholder={chosen.title} maxLength={80} onChange={(e) => setName(e.target.value)} />
              </div>
              {props.map(([k, p]) => (
                <div className="field" key={k}>
                  <label htmlFor={`channel-in-${k}`}>
                    {k}
                    {chosen.input.required?.includes(k) ? <span className="req"> *</span> : null}
                    {p.description ? <span className="muted"> — {p.description}</span> : null}
                  </label>
                  <input id={`channel-in-${k}`} value={inputs[k] ?? ''} onChange={(e) => setInputs({ ...inputs, [k]: e.target.value })} />
                </div>
              ))}
              <div>
                <button type="submit" className="primary" disabled={act.busy}>
                  Add channel
                </button>
              </div>
            </>
          ) : null}
        </form>
      ) : null}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}


interface Decision { id: string; question: string; answer: string; about: string[]; source: { type: string; id: string | null }; by: string | null; at: string }

/**
 * What this team already told Dittoly while drafting. Each answer is kept once, handed to the next draft instead
 * of asking the same question again, and replaced when they answer differently. Anyone in the team can read them
 * and take one away — it is their words, and a wrong one would be repeated into every later draft.
 */
function TeamDecisionsCard({ team }: { team: Team }) {
  const list = useLoad(() => api<{ decisions: Decision[]; unreadable: number }>(`/teams/${team.id}/decisions`), [team.id]);
  const act = useAction();
  return (
    <Card title={<><Icon name="sparkles" />{team.name}: what you have told the AI</>}>
      <p className="muted">
        The answers this team gave while drafting — which channel, which project, which branch. A later draft is given the ones about the apps it uses, instead of asking again.
        They decide nothing on their own: an answer given in that request wins over the one here, and every version still goes through its checks and its approver.
      </p>
      {list.data?.unreadable ? (
        <Notice>
          <strong>{list.data.unreadable} answer(s) cannot be read with the key in use.</strong> They are not lost, but drafts are told they are missing and will ask again rather
          than guess. If the master key was rotated or restored, check the backup.
        </Notice>
      ) : null}
      {list.error ? <ErrorText>{list.error}</ErrorText> : !list.data ? <Loading /> : !list.data.decisions.length ? (
        <Empty>Nothing yet. Answers you give while drafting a Flow or a module turn up here.</Empty>
      ) : (
        <ul className="list">
          {list.data.decisions.map((d) => (
            <li key={d.id}>
              <div>
                <strong>{d.question}</strong> <span>{d.answer}</span>
                <div className="muted">
                  {d.about.length ? <>about <code>{d.about.join(', ')}</code> · </> : <>about no app in particular · </>}
                  {d.by ? `${d.by} · ` : ''}while drafting a {d.source.type} · <When at={d.at} />
                </div>
              </div>
              <button
                type="button"
                className="ghost small"
                disabled={act.busy}
                onClick={() => act.run(async () => (await api(`/teams/${team.id}/decisions/${d.id}`, { method: 'DELETE' }), list.reload()), 'Forgotten')}
              >
                Forget it
              </button>
            </li>
          ))}
        </ul>
      )}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

/** Org admins: how many of a team's runs go at once, so one busy team cannot take every run slot. */
function TeamRunLimit({ team, onChange }: { team: Team; onChange: () => void }) {
  const [value, setValue] = useState(team.runLimit === null ? '' : String(team.runLimit));
  const act = useAction();
  const save = (runLimit: number | null) =>
    act.run(async () => {
      await api(`/teams/${team.id}/run-limit`, { method: 'PUT', body: { runLimit } });
      onChange();
    }, runLimit === null ? 'No limit for this team' : `At most ${runLimit} at once`);
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1 && n <= 100;
  return (
    <Card title={<><Icon name="bolt" />{team.name}: runs at once</>}>
      <p className="muted">
        The server works on a few runs at a time. A limit stops one busy team from taking all of them: its other runs wait their turn while other teams go on. Runs waiting for a person take no place.
        {' '}Now: {team.runLimit === null ? 'no limit' : `at most ${team.runLimit}`}.
      </p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (valid) save(n); }}>
        <div className="field">
          <label htmlFor={`run-limit-${team.id}`}>At most this many at once (1–100)</label>
          <input id={`run-limit-${team.id}`} type="number" min={1} max={100} inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <button type="submit" className="primary" disabled={act.busy || !valid}>Save</button>
        {team.runLimit !== null ? <button type="button" className="ghost" disabled={act.busy} onClick={() => { setValue(''); save(null); }}>Remove the limit</button> : null}
      </form>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}
