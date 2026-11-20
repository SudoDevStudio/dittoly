import { useState } from 'react';
import { api } from '../api';
import { Card, Empty, ErrorText, Loading, Page, useAction, useLoad } from '../components';
import { useMe } from '../context';
import { Link } from '../router';
import { useTeams } from '../teams';
import { Icon, Metric } from '../ui';

interface FlowInsight {
  flowId: string; name: string; team: string | null; runs: number; succeeded: number; failed: number; cancelled: number; dry: number;
  successRate: number | null; medianSeconds: number | null; p90Seconds: number | null; waitingSeconds: number;
  manualMinutes: number | null; savedMinutes: number | null; topFailures: { step: string; errorType: string; count: number }[];
}
interface Insights {
  days: number;
  totals: { runs: number; succeeded: number; failed: number; successRate: number | null; savedMinutes: number; flowsWithoutManualTime: number };
  flows: FlowInsight[];
  waits: { kind: string; count: number; medianSeconds: number | null; longestSeconds: number | null }[];
}

/** 75 → "1 min 15 s", 7200 → "2 h". */
export function duration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min${seconds % 60 ? ` ${seconds % 60} s` : ''}`;
  if (seconds < 86_400) return `${Math.round((seconds / 3600) * 10) / 10} h`;
  return `${Math.round((seconds / 86_400) * 10) / 10} days`;
}
const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
const hours = (minutes: number) => (minutes < 60 ? `${minutes} min` : `${Math.round((minutes / 60) * 10) / 10} h`);

export function InsightsPage() {
  const { me } = useMe();
  const { current: team } = useTeams();
  const [days, setDays] = useState(30);
  const data = useLoad(() => api<Insights>(`/insights?days=${days}${team ? `&team=${team}` : ''}`), [days, team]);
  const act = useAction();
  const d = data.data;
  return (
    <Page title="Insights" eyebrow="OPERATIONS / RUN INSIGHTS & AI USAGE" description="Which Flows fail and where, how long runs wait on people, and the time Flows save." actions={
      <select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
        <option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
      </select>
    }>
      <ErrorText>{data.error ?? act.error}</ErrorText>
      {!d ? <Loading /> : (
        <>
          <div className="metrics">
            <Metric label="Runs" value={d.totals.runs} detail={`last ${d.days} days`} icon="bolt" />
            <Metric label="Succeeded" value={pct(d.totals.successRate)} detail={`${d.totals.succeeded} succeeded, ${d.totals.failed} failed`} icon="check" />
            <Metric label="Time saved" value={hours(d.totals.savedMinutes)} detail={d.totals.flowsWithoutManualTime ? `${d.totals.flowsWithoutManualTime} Flow(s) without a manual time` : 'by successful runs'} icon="sparkles" />
            <Metric label="Waiting on people" value={duration(d.waits.find((w) => w.kind === 'sign-off')?.medianSeconds ?? null)} detail="median sign-off wait" icon="users" />
          </div>
          <SavingsCard days={days} team={team} />
          <Card title={<><Icon name="flow" />Flows</>}>
            {d.flows.length === 0 ? <Empty>No Flows yet.</Empty> : (
              <div className="table-wrap">
                <table aria-label="Flow insights">
                  <thead><tr><th>Flow</th><th>Runs</th><th>Succeeded</th><th>Median time</th><th>Waiting on people</th><th>By hand (min/run)</th><th>Saved</th><th>Fails most at</th></tr></thead>
                  <tbody>
                    {d.flows.map((f) => (
                      <tr key={f.flowId}>
                        <td><Link to={`/flows/${f.flowId}`}>{f.name}</Link>{f.team ? <div className="muted">{f.team}</div> : null}</td>
                        <td>{f.runs}{f.dry ? <span className="muted"> ({f.dry} dry)</span> : null}</td>
                        <td>{pct(f.successRate)}</td>
                        <td>{duration(f.medianSeconds)}{f.p90Seconds !== null ? <div className="muted">90%: {duration(f.p90Seconds)}</div> : null}</td>
                        <td>{duration(f.waitingSeconds || null)}</td>
                        <td>
                          <input aria-label={`Minutes by hand for ${f.name}`} className="narrow" type="number" min={1} max={10000} defaultValue={f.manualMinutes ?? ''} placeholder="—"
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              const minutes = v === '' ? null : Number(v);
                              if (minutes === f.manualMinutes) return;
                              void act.run(async () => (await api(`/flows/${f.flowId}/manual-minutes`, { method: 'PUT', body: { minutes } }), data.reload()), 'Manual time saved');
                            }} />
                        </td>
                        <td>{f.savedMinutes === null ? '—' : hours(f.savedMinutes)}</td>
                        <td>{f.topFailures.length ? f.topFailures.map((x) => <div key={x.step + x.errorType}>{x.step}: <code>{x.errorType}</code> ×{x.count}</div>) : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted">"By hand" is how long one run would take without Dittoly; its owner sets it. Time saved counts successful runs only, not dry runs.</p>
          </Card>
          <Card title={<><Icon name="users" />Waiting on people</>}>
            <ul className="list" aria-label="Waits">
              {d.waits.map((w) => <li key={w.kind}><strong>{w.kind === 'sign-off' ? 'Sign-offs' : w.kind === 'form' ? 'Forms' : 'Teammate requests'}</strong>: {w.count} answered, median {duration(w.medianSeconds)}, longest {duration(w.longestSeconds)}</li>)}
            </ul>
          </Card>
        </>
      )}
      <AiUsageCard quiet={me.role === 'member'} />
    </Page>
  );
}

interface Usage {
  month: string;
  teams: { teamId: string; team: string; usedTokens: number; budgetTokens: number | null; warnPercent: number | null }[];
  lines: { team: string; purpose: string; keyOwner: string; provider: string; model: string; calls: number; inputTokens: number; outputTokens: number; estimatedCost: number | null; currency: string | null }[];
  prices: { provider: string; model: string; inputPerMillion: number; outputPerMillion: number; currency: string }[];
  unpriced: string[];
}
const fmt = (n: number) => n.toLocaleString();

/** AI use this month per team: tokens, budgets, estimated cost. Team admins see their teams; admins set budgets and prices. */
function AiUsageCard({ quiet = false }: { quiet?: boolean }) {
  const { me } = useMe();
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const usage = useLoad(() => api<Usage>(`/ai/usage?month=${month}`), [month]);
  const act = useAction();
  const [price, setPrice] = useState({ provider: '', model: '', inputPerMillion: '', outputPerMillion: '', currency: 'USD' });
  if (quiet && usage.error) return null;
  const u = usage.data;
  const costs = new Map<string, number>();
  for (const l of u?.lines ?? []) if (l.estimatedCost !== null) costs.set(l.currency!, (costs.get(l.currency!) ?? 0) + l.estimatedCost);
  return (
    <Card title={<><Icon name="sparkles" />AI usage</>} actions={<input aria-label="Month" type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}>
      <p className="muted">Tokens used by each team with the organization's AI, against its monthly budget. Prompts and answers are never kept, only counts. Runners' own keys are counted but never limited.</p>
      {usage.error ? <ErrorText>{usage.error}</ErrorText> : !u ? <Loading /> : (
        <>
          <ul className="list" aria-label="Team budgets">
            {u.teams.map((t) => {
              const share = t.budgetTokens ? Math.min(1, t.usedTokens / t.budgetTokens) : null;
              return (
                <li key={t.teamId} className="budget-row">
                  <strong>{t.team}</strong>
                  <span>{fmt(t.usedTokens)} tokens{t.budgetTokens ? ` of ${fmt(t.budgetTokens)}` : ' (no budget)'}</span>
                  {share !== null ? <span className="bar" role="meter" aria-label={`${t.team} budget used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}><span style={{ width: `${share * 100}%` }} className={share >= 1 ? 'over' : share * 100 >= (t.warnPercent ?? 80) ? 'warn' : ''} /></span> : null}
                  {me.role === 'admin' ? <BudgetForm team={t} onSaved={usage.reload} /> : null}
                </li>
              );
            })}
          </ul>
          {u.lines.length ? (
            <div className="table-wrap">
              <table aria-label="AI usage">
                <thead><tr><th>Team</th><th>For</th><th>Key</th><th>Model</th><th>Calls</th><th>Tokens in / out</th><th>Estimated cost</th></tr></thead>
                <tbody>{u.lines.map((l, i) => <tr key={i}><td>{l.team}</td><td>{l.purpose}</td><td>{l.keyOwner === 'organization' ? "organization's" : "runner's own"}</td><td><code>{l.provider}/{l.model}</code></td><td>{l.calls}</td><td>{fmt(l.inputTokens)} / {fmt(l.outputTokens)}</td><td>{l.estimatedCost === null ? '—' : `${l.estimatedCost.toFixed(2)} ${l.currency}`}</td></tr>)}</tbody>
              </table>
            </div>
          ) : <Empty>No AI use this month.</Empty>}
          {costs.size ? <p><strong>Estimated total:</strong> {[...costs].map(([c, v]) => `${v.toFixed(2)} ${c}`).join(' + ')}</p> : null}
          {u.unpriced.length ? <p className="muted">No price set for {u.unpriced.join(', ')}, so its cost is not estimated.</p> : null}
          {me.role === 'admin' ? (
            <details>
              <summary>Prices per million tokens</summary>
              <p className="muted">Enter your provider's current prices; Dittoly has none built in because they change.</p>
              <ul className="list">{u.prices.map((p) => <li key={p.provider + p.model}><code>{p.provider}/{p.model}</code>: {p.inputPerMillion} in, {p.outputPerMillion} out ({p.currency})<button className="ghost" onClick={() => act.run(async () => (await api(`/ai/prices?${new URLSearchParams({ provider: p.provider, model: p.model })}`, { method: 'DELETE' }), usage.reload()), 'Price removed')}>Remove</button></li>)}</ul>
              <div className="row">
                <input aria-label="Price provider" placeholder="provider, e.g. anthropic" value={price.provider} onChange={(e) => setPrice({ ...price, provider: e.target.value })} />
                <input aria-label="Price model" placeholder="model" value={price.model} onChange={(e) => setPrice({ ...price, model: e.target.value })} />
                <input aria-label="Input price per million" className="narrow" type="number" min={0} step="0.01" placeholder="in" value={price.inputPerMillion} onChange={(e) => setPrice({ ...price, inputPerMillion: e.target.value })} />
                <input aria-label="Output price per million" className="narrow" type="number" min={0} step="0.01" placeholder="out" value={price.outputPerMillion} onChange={(e) => setPrice({ ...price, outputPerMillion: e.target.value })} />
                <input aria-label="Currency" className="narrow" value={price.currency} onChange={(e) => setPrice({ ...price, currency: e.target.value.toUpperCase() })} />
                <button disabled={act.busy || !price.provider || !price.model || price.inputPerMillion === '' || price.outputPerMillion === ''} onClick={() => act.run(async () => (await api('/ai/prices', { method: 'PUT', body: { ...price, inputPerMillion: Number(price.inputPerMillion), outputPerMillion: Number(price.outputPerMillion) } }), usage.reload()), 'Price saved')}>Save price</button>
              </div>
            </details>
          ) : null}
        </>
      )}
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

function BudgetForm({ team, onSaved }: { team: Usage['teams'][number]; onSaved: () => void }) {
  const act = useAction();
  const [tokens, setTokens] = useState(team.budgetTokens ? String(team.budgetTokens) : '');
  return (
    <span className="row">
      <input aria-label={`Monthly token budget for ${team.team}`} className="narrow" type="number" min={1000} step={1000} placeholder="tokens / month" value={tokens} onChange={(e) => setTokens(e.target.value)} />
      <button disabled={act.busy || tokens === ''} onClick={() => act.run(async () => (await api(`/teams/${team.teamId}/ai-budget`, { method: 'PUT', body: { monthlyTokens: Number(tokens) } }), onSaved()), 'Budget saved')}>Set budget</button>
      {team.budgetTokens ? <button className="ghost" disabled={act.busy} onClick={() => act.run(async () => (await api(`/teams/${team.teamId}/ai-budget`, { method: 'DELETE' }), setTokens(''), onSaved()), 'Budget removed')}>No budget</button> : null}
    </span>
  );
}

interface Baseline { inputTokens: number; outputTokens: number; provider: string | null; model: string | null; source: 'assistant' | 'drafting' | 'owner'; costPerRun: { amount: number; currency: string } | null }
type Money = Record<string, number>;
interface FlowSaving { flowId: string; name: string; team: string | null; succeeded: number; baseline: Baseline | null; avoidedTokens: number; usedTokens: number; savedTokens: number; savedMoney: Money | null; savedMinutes: number | null; aiCostPerSuccessfulRun: { tokens: number; money: Money; unpriced: boolean } | null }
interface SavingTotals { runs: number; avoidedTokens: number; usedTokens: number; savedTokens: number; savedMoney: Money; savedMinutes: number }
interface Savings {
  days: number;
  totals: SavingTotals & { netTokens: number; netMoney: Money; flowsWithoutBaseline: number; unpricedBaselines: string[] };
  fixes: { tokens: number; cost: Money } | null;
  teams: (SavingTotals & { team: string; flows: number })[];
  flows: FlowSaving[];
}
const money = (m: Money | null) => (!m || !Object.keys(m).length ? '—' : Object.entries(m).map(([c, n]) => `${n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })} ${c}`).join(' + '));
const tokens = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());
const SOURCE = { assistant: 'reported by the AI assistant that saved it', drafting: "what drafting it with the organization's AI cost", owner: 'set by its owner' } as const;

/** Proof of savings: tokens and money not spent asking an AI every time, per team and Flow, after what fixes cost. */
function SavingsCard({ days, team }: { days: number; team: string | null }) {
  const data = useLoad(() => api<Savings>(`/insights/savings?days=${days}${team ? `&team=${team}` : ''}`), [days, team]);
  const act = useAction();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ inputTokens: '', outputTokens: '', provider: '', model: '' });
  const s = data.data;
  if (!s) return data.error ? <ErrorText>{data.error}</ErrorText> : <Loading />;
  const edit = (f: FlowSaving) => {
    setEditing(f.flowId);
    setForm({ inputTokens: String(f.baseline?.inputTokens ?? ''), outputTokens: String(f.baseline?.outputTokens ?? ''), provider: f.baseline?.provider ?? '', model: f.baseline?.model ?? '' });
  };
  const save = (flowId: string, baseline: unknown) => act.run(async () => (await api(`/flows/${flowId}/ai-baseline`, { method: 'PUT', body: { baseline } }), setEditing(null), data.reload()), 'Baseline saved');
  // Biggest savings first; Flows without a baseline last, so owners can set one.
  const ran = [...s.flows].sort((a, b) => b.savedTokens - a.savedTokens || Number(!!b.baseline) - Number(!!a.baseline) || b.succeeded - a.succeeded);
  return (
    <Card title={<><Icon name="sparkles" />Saved by not asking an AI every time</>}>
      <div className="metrics">
        <Metric label="AI tokens not spent" value={tokens(s.totals.savedTokens)} detail={`${s.totals.runs} successful runs, last ${s.days} days`} icon="sparkles" tone="ok" />
        <Metric label="Money saved" value={money(s.fixes ? s.totals.netMoney : s.totals.savedMoney)} detail={s.fixes ? 'after what fixes cost' : 'at your price table'} icon="check" />
        <Metric label="Time saved" value={hours(s.totals.savedMinutes)} detail="from each Flow's time by hand" icon="bolt" />
        {s.fixes ? <Metric label="AI spent on fixes" value={tokens(s.fixes.tokens)} detail={s.fixes.tokens ? `${money(s.fixes.cost)}, only when an app changed` : 'nothing broke'} icon="bolt" /> : null}
      </div>
      {s.totals.flowsWithoutBaseline ? <p className="muted">{s.totals.flowsWithoutBaseline} Flow(s) ran without a baseline, so their AI savings are not counted. Set one below.</p> : null}
      {s.totals.unpricedBaselines.length ? <p className="muted">No price yet for {s.totals.unpricedBaselines.map((m, i) => <span key={m}>{i ? ', ' : ''}<code>{m}</code></span>)}: add it under AI usage to see money.</p> : null}
      {s.teams.length > 1 ? (
        <div className="table-wrap">
          <table aria-label="Savings by team">
            <thead><tr><th>Team</th><th>Flows</th><th>Successful runs</th><th>Tokens not spent</th><th>Money saved</th><th>Time saved</th></tr></thead>
            <tbody>{s.teams.map((t) => <tr key={t.team}><td>{t.team}</td><td>{t.flows}</td><td>{t.runs}</td><td>{tokens(t.savedTokens)}</td><td>{money(t.savedMoney)}</td><td>{hours(t.savedMinutes)}</td></tr>)}</tbody>
          </table>
        </div>
      ) : null}
      {ran.length ? (
        <div className="table-wrap">
          <table aria-label="Savings by Flow">
            <thead><tr><th>Flow</th><th>Successful runs</th><th>Doing it with AI once</th><th>Tokens not spent</th><th>AI cost per successful run</th><th>Money saved</th><th></th></tr></thead>
            <tbody>
              {ran.map((f) => (
                <tr key={f.flowId}>
                  <td><Link to={`/flows/${f.flowId}`}>{f.name}</Link>{f.team ? <div className="muted">{f.team}</div> : null}</td>
                  <td>{f.succeeded}</td>
                  <td>
                    {editing === f.flowId ? (
                      <div className="row">
                        <input aria-label="Input tokens" className="narrow" type="number" min={0} placeholder="tokens in" value={form.inputTokens} onChange={(e) => setForm({ ...form, inputTokens: e.target.value })} />
                        <input aria-label="Output tokens" className="narrow" type="number" min={0} placeholder="tokens out" value={form.outputTokens} onChange={(e) => setForm({ ...form, outputTokens: e.target.value })} />
                        <input aria-label="Provider" className="narrow" placeholder="anthropic" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} />
                        <input aria-label="Model" placeholder="model" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
                      </div>
                    ) : f.baseline ? (
                      <>{tokens(f.baseline.inputTokens + f.baseline.outputTokens)} tokens{f.baseline.costPerRun ? ` (${money({ [f.baseline.costPerRun.currency]: f.baseline.costPerRun.amount })})` : ''}<div className="muted">{SOURCE[f.baseline.source]}</div></>
                    ) : <span className="muted">not set</span>}
                  </td>
                  <td>{f.baseline ? tokens(f.savedTokens) : '—'}{f.usedTokens ? <div className="muted">its AI steps used {tokens(f.usedTokens)}</div> : null}</td>
                  <td title="All real runs' AI (retries and failed runs too) over the successful ones">
                    {f.aiCostPerSuccessfulRun ? <>{tokens(f.aiCostPerSuccessfulRun.tokens)} tokens{Object.keys(f.aiCostPerSuccessfulRun.money).length ? ` (${money(f.aiCostPerSuccessfulRun.money)})` : ''}{f.aiCostPerSuccessfulRun.unpriced ? <div className="muted">some models have no price</div> : null}</> : '—'}
                  </td>
                  <td>{money(f.savedMoney)}</td>
                  <td>
                    {editing === f.flowId ? (
                      <>
                        <button className="primary" disabled={act.busy || form.inputTokens === '' || form.outputTokens === ''} onClick={() => save(f.flowId, { inputTokens: Number(form.inputTokens), outputTokens: Number(form.outputTokens), ...(form.provider ? { provider: form.provider } : {}), ...(form.model ? { model: form.model } : {}) })}>Save</button>
                        <button disabled={act.busy} onClick={() => setEditing(null)}>Cancel</button>
                      </>
                    ) : <button className="ghost" onClick={() => edit(f)}>{f.baseline ? 'Change' : 'Set baseline'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <Empty>No Flows yet.</Empty>}
      <p className="muted">A Flow's baseline is what doing its task with an AI cost once: as reported by the assistant that saved it, what drafting it cost, or what its owner set. Each successful run (not dry runs) saved that, minus what the run's own AI steps used. Money uses the price table under AI usage.</p>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}
