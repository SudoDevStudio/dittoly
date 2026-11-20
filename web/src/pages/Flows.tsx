import { useState } from 'react';
import { useDraftFlow } from '../FlowDrafting';
import { FixReview, type EvidenceGate } from '../FixEvidence';
import { AiTag } from './Modules';
import { FlowTestsCard } from '../FlowTests';
import { AssistantNote, McpFlowCard, type AssistantDraft } from '../Mcp';
import { ArtifactJournal } from '../Journal';
import { api, post } from '../api';
import { Card, ChatBox, CodeView, Empty, ErrorText, Loading, Page, Pre, Status, useAction, useLoad, When, DraftSources, type DraftSource } from '../components';
import { RunFormFields, runFormProblems, type FlowDefinitionView } from '../RunForm';
import { useMe } from '../context';
import { Link, navigate } from '../router';
import { FlowGraph, Icon, Notice, SearchField, type GraphStep } from '../ui';
import { stepsUsing, useRemoveStep } from '../remove-step';
import { teamQuery, useTeams } from '../teams';
import type { Runnable } from './RunHub';
import { FlowUrlsCard } from '../FlowUrls';
import { SuperFlowBuilder } from '../SuperFlowBuilder';
import { ExportFlow, ImportFlow } from '../FlowTransfer';
import { TagPicker } from '../TagPicker';
import { AccessPreviewCard, useMyGrants } from '../Governance';
import { ModuleLink } from '../ModuleLink';
import { CostForecast, PinnedModel, RunModelSelect, usesOrgAi, type Forecast } from '../Costs';
import { FlowDiff } from '../ModuleSafety';
import { ChangeLinkCard } from '../Changes';
import { FlowEditor } from '../FlowEditor';
import { WatchesCard } from '../Watches';
import { FlowStopBanner } from '../AutoStops';
import { FlowScore, type FlowQuality } from '../DraftScore';
import { DraftModelPicker } from '../DraftModel';

interface FlowItem {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  latest: { id: string; version: number; status: string };
  approvedVersionId: string | null;
  isSuper?: boolean;
}
interface Version { id: string; flowId: string; version: number; status: string; createdBy: string; decidedBy: string | null; modelLocked?: boolean; definition: { inputs: unknown; steps: GraphStep[] } }
interface Review {
  /** FLOW.md: what it does and how; a Super Flow's covers every Flow it runs. */
  guide?: string;
  id: string;
  flowId: string;
  version: number;
  status: string;
  createdBy: string;
  summary: string;
  modules: { ref: string; status: string }[];
  /** The hash of exactly what is approved: the definition and the modules it pins. */
  approvalHash?: string;
  /** What it may do, as rows to scan, and what it can never do whatever its steps say. */
  capabilities?: {
    hosts: { host: string; module: string; fromRun: boolean }[];
    changes: { step: string; title: string; module: string }[];
    credentials: { service: string; optional: boolean }[];
    uses: string[];
    never: string[];
  };
  /** What the draft is worth: guards in front of its changes, what it remembers, its examples. */
  quality?: FlowQuality | null;
  /** The Flows a Super Flow runs, as pinned. */
  flows?: { flowId: string; name: string; version: number; versionId: string; status: string }[];
  /** Apps of this Flow: the live pages this version breaks; those pinned to another version are unaffected. */
  appImpact?: { appId: string; name: string; problems: string[]; pinned: boolean }[];
  definition: { inputs: unknown };
  fromTemplate: { listingId: string; identical: boolean } | null;
  explanation?: string;
  generation: { by?: { provider: string; model: string | null; effort?: string | null } | null; instructions: { text: string; sha256: string } | null; assistant?: AssistantDraft | null; fix?: { module: string; fromVersion: string; toVersion: string; tests: { total: number; passed: number }; redrafted?: boolean } | null; git?: { commit: string; path: string } | null; classification?: { missing?: string[] } | null; sources?: DraftSource[] } | null;
  /** How many different approvers this version needs (a rule may ask for more than one), and who approved. */
  approvals?: { required: number; because: string | null; given: { handle: string; at: string }[] };
  /** Paths from text an AI wrote to steps that change something (prompt-injection containment). */
  injection?: Injection;
  /** The model its organization AI steps run with, and how it changed. */
  aiModel?: string | null;
  /** Locked by an approver to aiModel; else it follows the organization's model. */
  modelLocked?: boolean;
  /** Data tables approving creates in the Flow's team (or adds columns to). */
  tablesToCreate?: { name: string; purpose: string; exists: boolean; newColumns: string[] }[];
  modelPins?: Parameters<typeof PinnedModel>[0]['pins'];
  /** What one run is expected to spend on AI, and its cap. */
  costForecast?: Forecast | null;
  /** Sign-offs a fix step's verified change releases on its own (autoApproveWhen). */
  evidenceGates?: EvidenceGate[];
}
interface InjectionPath { source: string; sourceKind: 'ai' | 'browse' | 'fix' | 'flow' | 'app-data' | 'webhook'; sink: string; sinkKind: string; through: string[]; influence?: 'payload' | 'destination' | 'decision' | 'executable' }
interface Injection { paths: InjectionPath[]; sinks: string[]; accepted: { sink: string; reason: string; by: string | null; at: string }[]; guarded: string[] }
interface Schedule { id: string; flowVersionId: string; cron: string; timezone: string; enabled: boolean; disabledReason: string | null; nextRunAt: string }

/** Titles of one module's actions, from its newest approved version in the catalog (entries are "name@version"). */
export function moduleExamples(name: string, catalog: { module: string; title: string }[]): string[] {
  if (!name) return [];
  const mine = catalog.filter((a) => a.module.split('@')[0] === name);
  const newest = mine.at(-1)?.module;
  return mine.filter((a) => a.module === newest).map((a) => a.title);
}

export function Flows({ superOnly = false }: { superOnly?: boolean }) {
  const { current: team } = useTeams();
  // Filtered by the server: the list is capped, so filtering here could hide older Super Flows.
  const flows = useLoad(() => api<FlowItem[]>(`/flows${teamQuery(team)}${teamQuery(team) ? '&' : '?'}kind=${superOnly ? 'super' : 'flow'}`), [team, superOnly]);
  const draft = useAction();
  // "Draft a Flow with this module" from a module's page: the Flow is built around that module.
  const [useModule, setUseModule] = useState(() => new URLSearchParams(location.search).get('module') ?? '');
  const flowDraft = useDraftFlow({ ...(team ? { team } : {}), ...(useModule ? { module: useModule } : {}) });
  // The module's own actions (newest approved version), so the example and suggestions match what it can do.
  const moduleActions = useLoad(
    () => (useModule ? api<{ module: string; title: string }[]>('/catalog') : Promise.resolve([])),
    [useModule],
  );
  const actionTitles = moduleExamples(useModule, moduleActions.data ?? []);
  const [showJson, setShowJson] = useState(false);
  const [json, setJson] = useState('');
  const [name, setName] = useState('');
  const [q, setQ] = useState('');
  const [previewId, setPreviewId] = useState('');
  const [building, setBuilding] = useState(false);
  const listed = flows.data;
  const shownId = superOnly ? undefined : previewId || listed?.[0]?.id;
  const preview = useLoad(() => shownId ? api<Version[]>(`/flows/${shownId}/versions`) : Promise.resolve([]), [shownId]);
  const shown = preview.data?.at(-1);
  const filtered = listed?.filter(f => f.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <Page title={superOnly ? "Super Flows" : "Flows"} eyebrow="CONTROL PLANE / WORKFLOW SYNTHESIS" description={superOnly ? "Connect approved Flows into stages. Run stages in order and child Flows in parallel." : "Describe what should happen across your apps. Build a versioned Flow from approved modules, then review every step before execution."} className="flows-page">
      {!superOnly ? <><div className="studio-grid">
      <Card title={<><Icon name="sparkles"/>Describe a Flow</>}>
        <p className="muted">Say what should happen across your apps. The AI drafts a Flow from the approved modules; an approver signs it off before it can run.</p>
        {useModule ? (
          <p className="row" role="status">
            <span className="badge tone-info">Using module {useModule}</span>
            <button type="button" className="ghost" onClick={() => setUseModule('')}>Don't use it</button>
          </p>
        ) : null}
        <ChatBox
          placeholder={
            useModule
              ? `What should the Flow do with ${useModule}?${actionTitles.length ? ` It can: ${actionTitles.map((t) => t.toLowerCase()).join('; ')}.` : ''}`
              : 'e.g. gather approved Jira tickets, merge ready MRs after sign-off, notify the release channel'
          }
          button="Draft Flow"
          suggestions={useModule ? actionTitles.slice(0, 3) : ['List open pull requests and send a summary to Slack', 'Gather Jira tickets, request approval, then notify the release channel']}
          busy={flowDraft.busy}
          onSubmit={(text) => flowDraft.draft(text)}
        />
        {flowDraft.panels}
        <ErrorText>{draft.error}</ErrorText>
        <button className="ghost" onClick={() => setShowJson((s) => !s)} aria-expanded={showJson}>
          {showJson ? 'Hide' : 'Or paste a Flow definition (JSON)'}
        </button>
        {showJson ? (
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              draft.run(async () => {
                const v = await post<Version>('/flows', { name, definition: pastedDefinition(json), ...(team ? { teamId: team } : {}) });
                navigate(`/flows/${v.flowId}`);
              });
            }}
          >
            <div className="field">
              <label htmlFor="flow-name">Name</label>
              <input id="flow-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="flow-json">Definition</label>
              <textarea id="flow-json" rows={10} value={json} onChange={(e) => setJson(e.target.value)} required />
            </div>
            <div>
              <button type="submit" className="primary" disabled={draft.busy}>
                Create
              </button>
            </div>
          </form>
        ) : null}
      </Card>
      <div className="flow-canvas">
        <div className="canvas-caption"><span>FLOW PREVIEW / LATEST VERSION</span><Icon name="flow" size={15}/></div>
        {listed?.length ? <div className="pad"><select aria-label="Preview a Flow" value={shownId ?? ''} onChange={e => setPreviewId(e.target.value)}>{listed.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select><ErrorText>{preview.error}</ErrorText>{shown ? <><FlowGraph steps={shown.definition.steps} flowNames={Object.fromEntries((listed ?? []).map((f) => [f.id, f.name]))}/><Link to={`/flows/${shown.flowId}`} className="card-link">Review version {shown.version} <Icon name="arrow" size={16}/></Link></> : <Loading/>}</div> : <div className="studio-empty"><Icon name="flow" size={42}/><h2>Your next workflow starts here</h2><p>Describe what should happen. Once a Flow is drafted, its exact steps appear here.</p><span className="node-label">DESCRIBE → REVIEW → APPROVE → RUN</span></div>}
      </div>
      </div>
      {building ? <FlowEditor onClose={() => setBuilding(false)} /> : <div><button type="button" onClick={() => setBuilding(true)}><Icon name="flow" size={15} />Build a Flow visually</button></div>}
      </> : <SuperFlowBuilder />}
      {/* Importing a file is the rarer way in: folded on the Flows page (Super Flows keep it open). */}
      {superOnly ? <ImportFlow superOnly /> : <details className="more-ways"><summary>Import a Flow from a JSON file</summary><ImportFlow superOnly={false} /></details>}
      <div className="toolbar"><SearchField value={q} onChange={setQ} placeholder={superOnly ? "Filter Super Flows by name…" : "Filter Flows by name…"}/><span className="badge tone-info">{listed?.length ?? 0} {superOnly ? (listed?.length === 1 ? "Super Flow" : "Super Flows") : (listed?.length === 1 ? "Flow" : "Flows")}</span></div>
      <Card title={superOnly ? "Versioned Super Flows" : "Versioned Flows"}>
        {flows.error ? <ErrorText>{flows.error}</ErrorText> : null}
        {!listed ? (
          <Loading />
        ) : filtered?.length === 0 ? (
          <Empty>{listed.length ? "No Flows match your search." : superOnly ? "No Super Flows yet. Connect approved Flows above or import a Super Flow." : "No Flows yet. Describe your first workflow above."}</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Flow</th>
                  <th>Latest version</th>
                  <th>Runnable</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {filtered?.map((f) => (
                  <tr key={f.id}>
                    <td>
                      <Link to={`/flows/${f.id}`}>{f.name}</Link>
                      {f.isSuper ? <> <span className="badge super">Super Flow</span></> : null}
                    </td>
                    <td>
                      v{f.latest.version} <Status value={f.latest.status} />
                    </td>
                    <td>{f.approvedVersionId ? 'yes' : <span className="muted">no</span>}</td>
                    <td>
                      <When at={f.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {!superOnly ? <DeletedFlows /> : null}
    </Page>
  );
}

/** Admins: deleted (archived) Flows, to restore. */
function DeletedFlows() {
  const { me } = useMe();
  const { current: team } = useTeams();
  const [open, setOpen] = useState(false);
  const list = useLoad(() => (open ? api<FlowItem[]>(`/flows${teamQuery(team)}${teamQuery(team) ? '&' : '?'}archived=true`) : Promise.resolve([])), [open, team]);
  const act = useAction();
  if (me.role !== 'admin') return null;
  return (
    <Card title="Deleted Flows" actions={<button type="button" className="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : 'Show'}</button>}>
      {open ? (
        list.data?.length ? (
          <ul className="list">
            {list.data.map((f) => (
              <li key={f.id} className="row between">
                <span>{f.name} {f.isSuper ? <span className="badge super">Super Flow</span> : null}</span>
                <button type="button" disabled={act.busy} onClick={() => act.run(async () => { await post(`/flows/${f.id}/restore`); list.reload(); }, `${f.name} restored`)}>Restore</button>
              </li>
            ))}
          </ul>
        ) : <Empty>No deleted Flows.</Empty>
      ) : <p className="muted">Deleted Flows keep their versions, runs and audit history. An admin can bring one back here.</p>}
      <ErrorText>{act.error ?? list.error}</ErrorText>
    </Card>
  );
}

/**
 * Delete a Flow (a Super Flow too): it is archived, never runs again, and leaves the lists; its versions, runs
 * and history stay. Refused while another Flow runs it or a run of it is still active (the message lists them).
 */
function DeleteFlow({ flowId, name, back }: { flowId: string; name: string; back: string }) {
  const act = useAction();
  return (
    <Card title="Delete this Flow">
      <p className="muted">It stops for good: its URLs, webhooks, schedules and watches start nothing. Its versions, runs and audit history are kept, and an admin can restore it.</p>
      <div className="row">
        <button
          type="button"
          className="danger"
          disabled={act.busy}
          onClick={() => {
            if (!confirm(`Delete "${name}"?`)) return;
            act.run(async () => { await api(`/flows/${flowId}`, { method: 'DELETE' }); navigate(back); }, `${name} deleted`);
          }}
        >
          Delete Flow
        </button>
      </div>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

interface Followup {
  id: string;
  target: { versionId: string; name: string; version: number };
  on: 'succeeded' | 'failed' | 'finished';
  mine: boolean;
  inputs: Record<string, unknown> | null;
  enabled: boolean;
  disabledReason: string | null;
  lastRunId: string | null;
}
const ON_LABEL = { succeeded: 'succeeds', failed: 'fails', finished: 'finishes' } as const;

/** "When my run of this Flow finishes, run that one": runs as you, after your own runs only. */
function FollowupsCard({ flowId, source }: { flowId: string; source: FlowDefinitionView & { steps: { id: string }[] } }) {
  const list = useLoad(() => api<Followup[]>(`/followups?flow=${flowId}`), [flowId]);
  const runnable = useLoad(() => api<Runnable[]>('/runnable'));
  const [target, setTarget] = useState('');
  const [on, setOn] = useState<Followup['on']>('succeeded');
  const [values, setValues] = useState<Record<string, string>>({});
  const targetReview = useLoad(() => (target ? api<{ definition: FlowDefinitionView }>(`/flow-versions/${target}/review`) : Promise.resolve(null)), [target]);
  const act = useAction();
  const schema = (targetReview.data?.definition.inputs ?? {}) as { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
  const fields = Object.entries(schema.properties ?? {});
  const sourceInputs = Object.keys(((source.inputs ?? {}) as { properties?: object }).properties ?? {});
  const hints = [...sourceInputs.map((n) => `{{ inputs.${n} }}`), ...source.steps.map((s) => `{{ steps.${s.id}.output }}`)];
  const pick = (versionId: string) => {
    setTarget(versionId);
    setValues({});
  };
  // A field typed as a number takes a number; templates stay as written (they keep the value's type).
  const typed = (name: string, v: string): unknown => {
    const t = schema.properties?.[name]?.type;
    if (/^\{\{.*\}\}$/.test(v.trim())) return v.trim();
    if ((t === 'integer' || t === 'number') && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
    if (t === 'boolean') return v === 'true';
    return v;
  };
  return (
    <Card title={<><Icon name="arrow"/>Then run another Flow</>}>
      <p className="muted">
        When your run of this Flow finishes, start another one as you, with values from the finished run, e.g. run a browser test after a release.
        Other people's runs do not start it. Stops if that Flow's version loses its approval.
      </p>
      <div className="field">
        <label htmlFor="fu-target">Flow to run</label>
        <select id="fu-target" value={target} onChange={(e) => pick(e.target.value)}>
          <option value="">Choose an approved Flow…</option>
          {runnable.data?.filter((r) => r.flowId !== flowId).map((r) => <option key={r.versionId} value={r.versionId}>{r.name} (v{r.version})</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="fu-on">When this Flow</label>
        <select id="fu-on" value={on} onChange={(e) => setOn(e.target.value as Followup['on'])}>
          <option value="succeeded">succeeds</option>
          <option value="failed">fails</option>
          <option value="finished">finishes either way</option>
        </select>
      </div>
      {fields.map(([name, p]) => (
        <div className="field" key={name}>
          <label htmlFor={`fu-in-${name}`}>{name}{schema.required?.includes(name) ? ' *' : ''}</label>
          <input id={`fu-in-${name}`} list="fu-hints" placeholder={sourceInputs.includes(name) ? `{{ inputs.${name} }}` : p.description ?? 'a value, or {{ steps.<id>.output.<field> }}'} value={values[name] ?? ''} onChange={(e) => setValues({ ...values, [name]: e.target.value })} />
        </div>
      ))}
      <datalist id="fu-hints">{hints.map((h) => <option key={h} value={h} />)}</datalist>
      <div>
        <button
          disabled={act.busy || !target}
          onClick={() =>
            act.run(async () => {
              const inputs = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, typed(k, v)]));
              await post('/followups', { sourceFlowId: flowId, targetVersionId: target, on, inputs });
              pick('');
              list.reload();
            }, 'Follow-up added')
          }
        >
          Add follow-up
        </button>
      </div>
      <ErrorText>{act.error}</ErrorText>
      <ul className="list">
        {list.data?.map((f) => (
          <li key={f.id}>
            When it {ON_LABEL[f.on]}, run <strong>{f.target.name}</strong> v{f.target.version} <Status value={f.enabled ? 'running' : 'cancelled'} />
            {!f.enabled && f.disabledReason ? <span className="muted">{f.disabledReason.replace(/_/g, ' ')}</span> : null}
            {f.lastRunId ? <Link to={`/runs/${f.lastRunId}`}>last run</Link> : null}
            {f.mine ? (
              <>
                <button className="ghost" onClick={() => act.run(async () => (await api(`/followups/${f.id}`, { method: 'PATCH', body: { enabled: !f.enabled } }), list.reload()))}>{f.enabled ? 'Turn off' : 'Turn on'}</button>
                <button className="ghost" onClick={() => act.run(async () => (await api(`/followups/${f.id}`, { method: 'DELETE' }), list.reload()), 'Follow-up removed')}>Remove</button>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** A pasted definition, or a whole template file ({ name, definition }). */
function pastedDefinition(json: string): unknown {
  const parsed = JSON.parse(json) as Record<string, unknown> | null;
  return parsed && typeof parsed === 'object' && 'definition' in parsed && !('steps' in parsed) ? parsed.definition : parsed;
}

/** Re-draft a Flow from JSON: a new version of the same Flow, so its URLs, triggers and history stay. */
function ReplaceDefinition({ flowId, current, onSaved }: { flowId: string; current: unknown; onSaved: () => void }) {
  const act = useAction();
  const [open, setOpen] = useState(false);
  const [json, setJson] = useState('');
  if (!open) {
    return (
      <button type="button" className="ghost" onClick={() => { setJson(JSON.stringify(current, null, 2)); setOpen(true); }} aria-expanded={false}>
        Or replace the definition (JSON)
      </button>
    );
  }
  return (
    <form
      className="form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        act.run(async () => {
          await api(`/flows/${flowId}`, { method: 'PUT', body: { definition: pastedDefinition(json) } });
          setOpen(false);
          onSaved();
        }, 'New version drafted; it needs approval before it runs');
      }}
    >
      <div className="field">
        <label htmlFor={`replace-json-${flowId}`}>Definition</label>
        <textarea id={`replace-json-${flowId}`} rows={14} value={json} onChange={(e) => setJson(e.target.value)} required />
      </div>
      <p className="muted">
        Paste a definition, or a whole Flow file (<code>{"{"} name, definition {"}"}</code>). It becomes a new version of this Flow: its URLs,
        triggers and runs stay, and URLs that follow the latest approved version use it once it is approved.
      </p>
      <div className="row">
        <button type="submit" className="primary" disabled={act.busy || !json.trim()}>Save JSON as new version</button>
        <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <ErrorText>{act.error}</ErrorText>
    </form>
  );
}

export function FlowDetail({ id }: { id: string }) {
  const { me, mode } = useMe();
  const versions = useLoad(() => api<Version[]>(`/flows/${id}/versions`), [id]);
  const archived = useLoad(() => api<{ name: string; archived: boolean }>(`/flows/${id}/archived`), [id]);
  const latest = versions.data?.at(-1);
  const approved = versions.data?.find((v) => v.status === 'approved');
  const [selected, setSelected] = useState<string | null>(null);
  const shownId = selected ?? latest?.id;
  const review = useLoad(() => (shownId ? api<Review>(`/flow-versions/${shownId}/review`) : Promise.resolve(null)), [shownId]);
  const upgrades = useLoad(
    () => (approved ? api<Upgrade[]>(`/flow-versions/${approved.id}/upgrades`) : Promise.resolve([])),
    [approved?.id],
  );
  const schedules = useLoad(() => api<Schedule[]>('/schedules'));
  const act = useAction();
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const grants = useMyGrants();
  const [runAs, setRunAs] = useState('');
  const [triedRun, setTriedRun] = useState(false);
  const [runModel, setRunModel] = useState('');
  const [editing, setEditing] = useState(false);
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [listing, setListing] = useState({ title: '', summary: '' });
  const [listingTags, setListingTags] = useState<string[]>([]);
  /** Prompt-injection paths the approver accepts, by the step they reach, with the reason. */
  const [accept, setAccept] = useState<Record<string, string>>({});
  const [acceptBreaks, setAcceptBreaks] = useState(false);
  // Removing a step, one click on its node in the graph: a new version to approve, shown once it is made.
  const removeStep = useRemoveStep(id, () => {
    setSelected(null);
    versions.reload();
    review.reload();
  });

  if (versions.error) return <ErrorText>{versions.error}</ErrorText>;
  if (!versions.data || !latest) return <Loading />;
  const r = review.data;
  const canDecide = r && r.status === 'pending' && (me.role === 'admin' || me.role === 'approver') && (mode === 'local' || r.createdBy !== me.id);
  const isOwner = latest.createdBy === me.id || me.role === 'admin';
  const reload = () => {
    versions.reload();
    review.reload();
  };
  // The lists sort a Flow by its latest version, so go back to the list that shows it.
  const back = latest.definition.steps.some((s) => s.type === 'flow') ? '/super-flows' : '/flows';

  return (
    <Page title="Flow review" eyebrow="AI FLOW STUDIO / VERSIONED WORKFLOW" actions={<><ExportFlow versionId={shownId ?? latest.id} name={archived.data?.name}/><Link to={back} className="button"><Icon name="arrow" size={16}/>All Flows</Link></>}>
      {archived.data?.archived ? <Notice><strong>This Flow was deleted.</strong> It cannot run; its history is kept. An admin can restore it under Flows → Deleted Flows.</Notice> : null}
      <FlowStopBanner flowId={id} />
      <FlowGraph
        steps={versions.data.find(v => v.id === shownId)?.definition.steps ?? []}
        flowNames={Object.fromEntries((review.data?.flows ?? []).map((f) => [f.flowId, f.name]))}
        // The newest version's steps can be removed from here, one click each (a new version to approve).
        remove={isOwner && shownId === latest.id ? { onRemove: removeStep.remove, busyId: removeStep.busyId, busy: removeStep.busy, usedBy: (sid) => stepsUsing(latest.definition.steps as never, sid) } : undefined}
      />
      <ErrorText>{removeStep.error}</ErrorText>
      <ArtifactJournal type="flow" id={id} />
      <Card title="Versions">
        <ul className="list">
          {versions.data.map((v) => (
            <li key={v.id}>
              <button className={v.id === shownId ? 'primary' : ''} onClick={() => setSelected(v.id)} aria-pressed={v.id === shownId}>
                v{v.version}
              </button>
              <Status value={v.status} />
            </li>
          ))}
        </ul>
        <p className="muted">Any change creates a new version. The previous approval stops counting until the new version is approved.</p>
      </Card>

      {r ? (
        <Card title={`Version ${r.version}`} actions={<><AiTag by={r.generation?.by} /><Status value={r.status} /></>}>
          {r.fromTemplate ? (
            <p className="muted">
              Created from a marketplace template{r.fromTemplate.identical ? ', unchanged.' : ', with changes.'}
            </p>
          ) : null}
          <h2>What it does</h2>
          <FlowSummary text={r.summary} />
          {r.quality ? (
            <>
              <h2>What this draft is worth</h2>
              <FlowScore q={r.quality} />
            </>
          ) : null}
          <Capabilities caps={r.capabilities} version={r.version} status={r.status} hash={r.approvalHash} />
          <FlowDiff versionId={r.id} />
          {r.generation?.fix ? <ChangeLinkCard flowVersionId={r.id} /> : null}
          {r.generation?.assistant ? <AssistantNote draft={r.generation.assistant} what="Flow" /> : null}
          {r.generation?.classification?.missing?.length ? (
            <div className="assistant-note" role="note">
              <p><Icon name="info" size={14} /> Built anyway, although no approved module could: {r.generation.classification.missing.join(', ')}. Check what the draft does instead before approving it.</p>
            </div>
          ) : null}
          {r.generation?.git ? (
            <div className="assistant-note" role="note">
              <p><Icon name="refresh" size={14} /> From git: merged into the connected repository as <code>{r.generation.git.path}</code> (commit <code>{r.generation.git.commit.slice(0, 8)}</code>). Review it like any change; the approved version keeps running until this one is approved.</p>
            </div>
          ) : null}
          {r.generation?.fix ? (
            <div className="assistant-note" role="note">
              <p><Icon name="sparkles" size={14} /> Proposed by Dittoly: the app behind <strong>{r.generation.fix.module}</strong> changed, so this version uses the fixed module <code>{r.generation.fix.module}@{r.generation.fix.toVersion}</code> instead of <code>{r.generation.fix.fromVersion}</code>. {r.generation.fix.redrafted ? 'The fixed module asks for something else than this Flow was sending it, so the AI drafted the steps that use it again — read them below.' : 'Nothing else changed.'} {r.generation.fix.tests.total ? `All ${r.generation.fix.tests.total} of the Flow's tests pass with it.` : 'The Flow has no tests, so only its definition was checked.'} The approved version keeps running until this one is approved.</p>
            </div>
          ) : null}
          {r.generation?.sources?.length ? (
            <details>
              <summary className="muted">Sources the AI drafted from ({r.generation.sources.length})</summary>
              <DraftSources sources={r.generation.sources} />
            </details>
          ) : null}
          {r.generation?.instructions ? (
            <details>
              <summary className="muted">Drafted with the organization's AI instructions</summary>
              <Pre>{r.generation.instructions.text}</Pre>
            </details>
          ) : null}
          {r.flows?.length ? (
            <>
              <h2>Flows it runs (pinned versions) <span className="badge super">Super Flow</span></h2>
              <ul className="list">
                {r.flows.map((f) => (
                  <li key={f.versionId}>
                    <Icon name="flow" size={15} /><Link to={`/flows/${f.flowId}`}>{f.name}</Link> <code>v{f.version}</code> <Status value={f.status} />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {r.modules.length ? <h2>Modules (pinned versions)</h2> : null}
          <ul className="list">
            {r.modules.map((m) => (
              <li key={m.ref}>
                <code><ModuleLink refText={m.ref} /></code> <Status value={m.status} />
              </li>
            ))}
          </ul>
          {r.tablesToCreate?.length ? (
            <>
              <h2>Data tables</h2>
              <ul className="list" aria-label="Data tables approving creates">
                {r.tablesToCreate.map((t) => (
                  <li key={t.name}>
                    {t.exists ? <>Approving adds the columns <code>{t.newColumns.join(', ')}</code> to the team's table <strong>{t.name}</strong>.</> : <>Approving creates the team's table <strong>{t.name}</strong> (<code>{t.newColumns.join(', ')}</code>): {t.purpose}</>}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <h2>Which AI does what</h2>
          <p className="muted">
            Two different models, chosen apart: the one that <strong>writes</strong> this Flow when you draft or change it, and the one its AI steps
            use when it <strong>runs</strong>. Changing the first never changes a run; changing the second is a change to what is approved.
          </p>
          <p>
            <strong>Writes it:</strong> <DraftModelPicker type="flow" id={r.flowId} what="this Flow" />{' '}
            <span className="muted">Its owner or an admin. A Flow with no choice of its own follows yours, then the organization's.</span>
          </p>
          {r.modelPins ? (
            <PinnedModel versionId={r.id} model={r.aiModel ?? null} locked={r.modelLocked === true} pins={r.modelPins} status={r.status} canLock={me.role === 'admin' || me.role === 'approver'} onChanged={() => review.reload()} />
          ) : (
            <p className="muted">This Flow has no AI steps, so nothing about it depends on a model when it runs.</p>
          )}
          {r.costForecast ? <CostForecast forecast={r.costForecast} /> : null}
          {r.approvals && r.approvals.required > 1 ? (
            <p className="muted" aria-label="Approvals">
              <Icon name="users" size={14} />Approvals: {r.approvals.given.length} of {r.approvals.required}
              {r.approvals.given.length ? ` (${r.approvals.given.map((g) => g.handle).join(', ')})` : ''}. {r.approvals.because}
            </p>
          ) : null}
          <FixReview steps={((r.definition as { steps?: Parameters<typeof FixReview>[0]['steps'] }).steps ?? [])} gates={r.evidenceGates ?? []} />
          {r.injection?.paths.length ? <InjectionPanel injection={r.injection} canDecide={!!canDecide} accept={accept} setAccept={setAccept} /> : null}
          {r.appImpact?.length ? <AppImpactPanel impact={r.appImpact} canDecide={!!canDecide} accepted={acceptBreaks} setAccepted={setAcceptBreaks} /> : null}
          {canDecide ? (
            <div className="row">
              <button
                className="primary"
                disabled={act.busy || Object.values(accept).some((reason) => reason.trim().length < 10) || (!!r.appImpact?.some((a) => a.problems.length) && !acceptBreaks)}
                onClick={() =>
                  act.run(async () => {
                    const chosen = Object.entries(accept).map(([sink, reason]) => ({ sink, reason: reason.trim() }));
                    await post(`/flow-versions/${r.id}/decision`, { decision: 'approved', ...(chosen.length ? { accept: chosen } : {}), ...(acceptBreaks ? { acceptAppBreaks: true } : {}) });
                    setAccept({});
                    setAcceptBreaks(false);
                    reload();
                  }, 'Flow version approved')
                }
              >
                Approve this version
              </button>
              <button className="danger" disabled={act.busy} onClick={() => act.run(async () => (await post(`/flow-versions/${r.id}/decision`, { decision: 'rejected' }), reload()), 'Flow version rejected')}>
                Reject
              </button>
            </div>
          ) : null}
          {r.guide ? (
            <details>
              <summary>{r.flows?.length ? 'FLOW.md: the whole process, every Flow it runs' : 'FLOW.md: the Flow, step by step'}</summary>
              <div className="guide pre-wrap">{r.guide}</div>
            </details>
          ) : null}
          <details>
            <summary>Definition</summary>
            <CodeView code={JSON.stringify(r.definition, null, 2)} label="flow.json" />
          </details>
        </Card>
      ) : (
        <Loading />
      )}
      <ErrorText>{act.error}</ErrorText>

      {upgrades.data?.length ? (
        <ModuleUpgrades flowId={id} upgrades={upgrades.data} canChange={isOwner} onDone={() => { reload(); upgrades.reload(); }} />
      ) : null}

      {approved ? <AccessPreviewCard versionId={approved.id} /> : null}
      {shownId ? <FlowTestsCard flowId={id} versionId={shownId} canManage={isOwner} definition={versions.data.find((v) => v.id === shownId)?.definition as never} /> : null}
      {approved ? (
        <div className="grid">
          <Card title={`Run v${approved.version} as ${runAs ? grants.find((g) => g.id === runAs)?.actAs ?? 'yourself' : 'yourself'}`}>
            <RunFormFields versionId={approved.id} definition={approved.definition as FlowDefinitionView} values={inputs} onChange={setInputs} showProblems={triedRun} />
            <RunModelSelect value={runModel} onChange={setRunModel} show={!approved.modelLocked && usesOrgAi(approved.definition.steps)} />
            <div>
              <button
                className="primary"
                disabled={act.busy}
                onClick={() => {
                  setTriedRun(true);
                  if (Object.keys(runFormProblems(approved.definition as FlowDefinitionView, inputs)).length) return;
                  act.run(async () => {
                    const { runId } = await post<{ runId: string }>(`/flow-versions/${approved.id}/runs`, { inputs, ...(runAs ? { breakglassId: runAs } : {}), ...(runModel ? { model: runModel } : {}) });
                    navigate(`/runs/${runId}`);
                  });
                }}
              >
                Run now
              </button>
              <button
                disabled={act.busy}
                title="Reads run for real; sign-offs and anything that changes data are skipped"
                onClick={() => {
                  setTriedRun(true);
                  if (Object.keys(runFormProblems(approved.definition as FlowDefinitionView, inputs)).length) return;
                  act.run(async () => {
                    const { runId } = await post<{ runId: string }>(`/flow-versions/${approved.id}/runs`, { inputs, dryRun: true, ...(runModel ? { model: runModel } : {}) });
                    navigate(`/runs/${runId}`);
                  });
                }}
              >
                Dry run
              </button>
              {grants.length ? (
                <select aria-label="Run as" value={runAs} onChange={(e) => setRunAs(e.target.value)}>
                  <option value="">Run as yourself</option>
                  {grants.map((g) => <option key={g.id} value={g.id}>Break-glass: as {g.actAs}</option>)}
                </select>
              ) : null}
            </div>
          </Card>
          <Card title="Schedule">
            <p className="muted">Runs as you, on this exact version, with these inputs. Stops if the version loses its approval.</p>
            <div className="field">
              <label htmlFor="cron">Cron (minute hour day month weekday)</label>
              <input id="cron" value={cron} onChange={(e) => setCron(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="tz">Time zone</label>
              <input id="tz" value={tz} onChange={(e) => setTz(e.target.value)} />
            </div>
            <div>
              <button
                disabled={act.busy}
                onClick={() => {
                  setTriedRun(true);
                  if (Object.keys(runFormProblems(approved.definition as FlowDefinitionView, inputs)).length) return;
                  act.run(async () => (await post('/schedules', { flowVersionId: approved.id, cron, timezone: tz, inputs }), schedules.reload()), 'Schedule added');
                }}
              >
                Add schedule
              </button>
            </div>
            <ul className="list">
              {schedules.data
                ?.filter((s) => versions.data!.some((v) => v.id === s.flowVersionId))
                .map((s) => (
                  <li key={s.id}>
                    <code>{s.cron}</code> {s.timezone} <Status value={s.enabled ? 'running' : 'cancelled'} />
                    {s.enabled ? (
                      <span className="muted">
                        next <When at={s.nextRunAt} />
                      </span>
                    ) : (
                      <span className="muted">{s.disabledReason?.replace(/_/g, ' ') ?? 'off'}</span>
                    )}
                    <button onClick={() => act.run(async () => (await api(`/schedules/${s.id}`, { method: 'PATCH', body: { enabled: !s.enabled } }), schedules.reload()))}>
                      {s.enabled ? 'Turn off' : 'Turn on'}
                    </button>
                  </li>
                ))}
            </ul>
          </Card>
          <FollowupsCard flowId={id} source={approved.definition as FlowDefinitionView & { steps: { id: string }[] }} />
        </div>
      ) : null}
      {approved ? <WatchesCard flowVersionId={approved.id} inputs={approved.definition.inputs} /> : null}
      {approved ? <McpFlowCard flowId={id} canChange={isOwner} /> : null}
      {approved ? (
        <FlowUrlsCard flowId={id} versions={versions.data} inputs={approved.definition.inputs} />
      ) : (
        <Card>
          <Empty>No approved version yet, so this Flow cannot run.</Empty>
        </Card>
      )}

      {isOwner && editing ? (
        <FlowEditor flowId={id} initial={{ name: '', definition: latest.definition as never }} onClose={() => { setEditing(false); reload(); }} />
      ) : null}
      {isOwner ? (
        <Card
          title="Change this Flow"
          actions={
            editing ? null : (
              <>
                <button
                  type="button"
                  disabled={act.busy}
                  title="The same Flow, written again on the newest approved modules and against the review Dittoly runs on every draft"
                  onClick={() => act.run(async () => (await post(`/flows/${id}/redraft`), setSelected(null), reload()), 'Drafted again: a new version to approve')}
                >
                  <Icon name="sparkles" size={15} />Draft it again
                </button>
                <button type="button" onClick={() => setEditing(true)}><Icon name="flow" size={15} />Edit visually</button>
              </>
            )
          }
        >
          <p className="muted">
            <strong>Draft it again</strong> keeps what this Flow does and writes it once more: the newest approved version of each
            module, and what a reviewer would otherwise send back (a sign-off before anything changes, a condition on it, remembering
            what it handled, examples). Or say what to change:
          </p>
          <ChatBox
            placeholder="e.g. also post the list of merged MRs to the channel"
            button="Draft new version"
            busy={act.busy}
            onSubmit={(text) => act.run(async () => (await post(`/flows/${id}/revise`, { feedback: text }), setSelected(null), reload()), 'New version drafted')}
          />
          <ReplaceDefinition flowId={id} current={latest.definition} onSaved={() => { setSelected(null); reload(); }} />
        </Card>
      ) : null}

      {isOwner && archived.data && !archived.data.archived ? <DeleteFlow flowId={id} name={archived.data.name} back={back} /> : null}

      {approved && (me.role === 'admin' || me.role === 'approver') ? (
        <Card title="Share as a marketplace template">
          <div className="field">
            <label htmlFor="tpl-title">Title</label>
            <input id="tpl-title" value={listing.title} onChange={(e) => setListing({ ...listing, title: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="tpl-summary">Summary</label>
            <input id="tpl-summary" value={listing.summary} onChange={(e) => setListing({ ...listing, summary: e.target.value })} />
          </div>
          <div className="field">
            <span className="label">Tags</span>
            <TagPicker value={listingTags} onChange={setListingTags} suggestFor={{ flowVersionId: approved.id }} ai={listing} />
          </div>
          <div>
            <button disabled={act.busy || !listing.title || !listing.summary} onClick={() => act.run(() => post('/marketplace/templates', { flowVersionId: approved.id, ...listing, tags: listingTags }), 'Published to the marketplace')}>
              Publish template
            </button>
          </div>
        </Card>
      ) : null}
    </Page>
  );
}

const SOURCE: Record<InjectionPath['sourceKind'], string> = {
  ai: 'AI step',
  browse: 'AI-guided browse step',
  fix: 'fix step: code an AI wrote',
  flow: 'Flow with an AI step',
  'app-data': 'an app’s own data: whoever wrote that ticket, page or message',
  webhook: 'the inputs a webhook, endpoint or trigger sent',
};
/** What the value is allowed to do where it lands, and so whether anybody has to look at it. */
const INFLUENCE: Record<NonNullable<InjectionPath['influence']>, string> = {
  payload: 'says something there (a fixed destination): runs as approved',
  destination: 'picks who or what it acts on',
  decision: 'decides whether the step runs',
  executable: 'is run there',
};

/**
 * Where text an AI wrote can decide what a later step changes. An attacker who controls what the
 * AI read (a ticket, a page, an email) could steer it; such steps wait for a sign-off at run time
 * unless the approver accepts the path, with a reason.
 */
/** Apps of this Flow: the live pages this version breaks (the approver confirms them), and apps pinned to another version. */
function AppImpactPanel({ impact, canDecide, accepted, setAccepted }: { impact: { appId: string; name: string; problems: string[]; pinned: boolean }[]; canDecide: boolean; accepted: boolean; setAccepted: (v: boolean) => void }) {
  const broken = impact.filter((a) => a.problems.length);
  return (
    <div className="stack" aria-label="Apps using this Flow">
      <h2>Apps using this Flow</h2>
      <ul className="list">
        {impact.map((a) => (
          <li key={a.appId}>
            <Icon name="grid" size={15} /><Link to={`/team-apps/${a.appId}`}>{a.name}</Link>{' '}
            {a.pinned ? (
              <span className="badge">pinned to another version: unaffected</span>
            ) : a.problems.length ? (
              <>
                <span className="badge tone-danger">its pages break</span>
                <ul className="list">{a.problems.map((p) => <li key={p} className="tone-bad">{p}</li>)}</ul>
              </>
            ) : (
              <span className="badge tone-ok">still fits</span>
            )}
          </li>
        ))}
      </ul>
      {broken.length && canDecide ? (
        <label className="row">
          <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          I accept that approving this version breaks these pages of {broken.map((a) => a.name).join(', ')} until their apps are updated (recorded in the audit log).
        </label>
      ) : null}
    </div>
  );
}

function InjectionPanel({ injection, canDecide, accept, setAccept }: { injection: Injection; canDecide: boolean; accept: Record<string, string>; setAccept: (a: Record<string, string>) => void }) {
  const accepted = new Map(injection.accepted.map((a) => [a.sink, a]));
  return (
    <div className="stack" aria-label="Prompt-injection check">
      <h2><Icon name="shield" size={16} />Text nobody here wrote can steer these steps</h2>
      <p className="muted">
        A ticket, a web page, an email or a webhook carries someone else&apos;s words, and so does anything an AI wrote from them. Text an AI wrote waits wherever it lands. Text an
        app or a webhook sent waits only where it <strong>decides</strong> something — which destination, whether the step runs, what is run — because carrying it into a fixed
        destination is the automation doing its job. Each waiting step asks for a sign-off when this version runs, unless you accept it here with a reason.
      </p>
      {injection.paths.some((p) => !injection.sinks.includes(p.sink)) ? (
        <details>
          <summary>Carried, but deciding nothing: {injection.paths.filter((p) => !injection.sinks.includes(p.sink)).length}</summary>
          <ul className="list">
            {injection.paths.filter((p) => !injection.sinks.includes(p.sink)).map((p, i) => (
              <li key={i}>
                <code>{p.sink}</code> carries what <code>{p.source}</code> sent ({SOURCE[p.sourceKind]}) into a fixed destination. It runs as approved.
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <ul className="list">
        {injection.sinks.map((sink) => {
          const into = injection.paths.filter((p) => p.sink === sink);
          const done = accepted.get(sink);
          return (
            <li key={sink} className="stack">
              <div>
                <code>{sink}</code> uses what {into.map((p) => <span key={p.source}><code>{p.source}</code> ({SOURCE[p.sourceKind]}{p.through.length ? `, through ${p.through.join(' → ')}` : ''}){p.influence ? <span className="muted"> — {INFLUENCE[p.influence]}</span> : null} </span>)}wrote.{' '}
                {done ? <span className="badge badge-wrap tone-ok"><span>Accepted by {done.by ?? 'an approver'}: {done.reason}</span></span> : injection.guarded.includes(sink) ? <span className="badge tone-warn">Waits for a sign-off</span> : null}
              </div>
              {canDecide && !done ? (
                <label className="row">
                  <input type="checkbox" checked={sink in accept} onChange={(e) => { const next = { ...accept }; if (e.target.checked) next[sink] = ''; else delete next[sink]; setAccept(next); }} />
                  Run it without a sign-off
                </label>
              ) : null}
              {sink in accept ? (
                <textarea rows={2} maxLength={500} aria-label={`Why ${sink} is safe without a sign-off`} placeholder="Why this is safe without a sign-off (at least 10 characters; kept in the audit log)" value={accept[sink]} onChange={(e) => setAccept({ ...accept, [sink]: e.target.value })} />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}


/**
 * What approving this version allows, in rows instead of prose: the apps it may reach, what it changes out there,
 * whose access it runs with, what it does on this machine — and, last, what it can never do whatever its steps
 * say, because the runtime enforces it. The approver reads this before the buttons below.
 */

/** A newer approved version of something this Flow pins: a module, or a Flow a Super Flow runs. */
interface Upgrade { kind?: 'module' | 'flow'; module: string; pinned: string; latest: string; flowId?: string }

/**
 * Newer approved modules, with the press that takes them: one button per module, and one for all of them. Moving
 * is a change like any other — it makes a new version its approvers decide on, and the approved one keeps running
 * until they do. A Flow a Super Flow runs is listed too, but is moved on its own page, not from here.
 */
function ModuleUpgrades({ flowId, upgrades, canChange, onDone }: { flowId: string; upgrades: Upgrade[]; canChange: boolean; onDone: () => void }) {
  const act = useAction();
  const modules = upgrades.filter((u) => u.kind !== 'flow');
  const flows = upgrades.filter((u) => u.kind === 'flow');
  const [note, setNote] = useState('');
  const move = (names: string[] | undefined, said: string) =>
    act.run(async () => {
      const out = await post<{ version: number; redrafted: boolean }>(`/flows/${flowId}/update-modules`, names ? { modules: names } : {});
      setNote(
        out.redrafted
          ? `Version ${out.version}: the newer module takes something else than this Flow was sending it, so the AI drafted the steps that use it again. Read them before approving.`
          : `Version ${out.version}: the same Flow on the newer module, nothing else changed.`,
      );
      onDone();
    }, said);
  return (
    <Card
      title="Newer module versions available"
      actions={
        canChange && modules.length > 1 ? (
          <button type="button" className="primary" disabled={act.busy} onClick={() => move(undefined, 'New version proposed, with every module moved')}>
            Update all ({modules.length})
          </button>
        ) : undefined
      }
    >
      <ul className="list">
        {modules.map((u) => (
          <li key={u.module}>
            <code>{u.module}</code> <span className="muted">pinned {u.pinned}</span> <span className="badge tone-info">{u.latest} approved</span>
            {canChange ? (
              <>
                {' '}
                <button type="button" className="ghost small" disabled={act.busy} onClick={() => move([u.module], `${u.module} ${u.latest}: new version proposed`)}>
                  Update to {u.latest}
                </button>
              </>
            ) : null}
          </li>
        ))}
        {flows.map((u) => (
          <li key={`flow-${u.module}`}>
            <strong>{u.module}</strong> <span className="muted">pinned {u.pinned}, latest approved {u.latest}</span>{' '}
            {u.flowId ? <Link to={`/flows/${u.flowId}`}>Open that Flow</Link> : null}
          </li>
        ))}
      </ul>
      {note ? <p className="tone-ok" role="status">{note}</p> : null}
      <p className="muted">
        {canChange
          ? "Moving makes a new version to approve; this Flow keeps running the version it was approved with until then. Its own examples are played against the newer modules, and where a re-pin alone would break them the AI drafts those steps again."
          : 'Its owner or an admin can move it. Moving makes a new version to approve; nothing changes until then.'}
      </p>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

function Capabilities({ caps, version, status, hash }: { caps: Review['capabilities']; version: number; status: string; hash?: string }) {
  if (!caps) return null;
  const rows: { icon: Parameters<typeof Icon>[0]['name']; title: string; detail?: string }[] = [
    ...caps.hosts.map((h) => ({ icon: 'globe' as const, title: `Talks to ${h.host}`, detail: `through ${h.module}${h.fromRun ? ' (the host is chosen when the run starts, within what the module allows)' : ''}` })),
    ...caps.changes.map((c) => ({ icon: 'bolt' as const, title: `Changes data: ${c.title}`, detail: `${c.module} · step ${c.step}` })),
    ...caps.credentials.map((c) => ({ icon: 'key' as const, title: `Uses the runner's own ${c.service} access`, detail: c.optional ? 'only when they have stored it; otherwise public data only' : 'the run stops if they have not stored it' })),
    ...caps.uses.map((u) => ({ icon: 'layers' as const, title: u })),
  ];
  return (
    <section className="caps" aria-label="What approving this allows">
      <ul className="caps-list">
        {rows.length ? (
          rows.map((row, i) => (
            <li key={`${row.title}-${i}`}>
              <span className="caps-icon"><Icon name={row.icon} size={16} /></span>
              <span><strong>{row.title}</strong>{row.detail ? <span className="muted"> {row.detail}</span> : null}</span>
            </li>
          ))
        ) : (
          <li><span className="caps-icon"><Icon name="info" size={16} /></span><span>It reaches no app and changes nothing outside Dittoly.</span></li>
        )}
      </ul>
      <p className="caps-verified">
        <Icon name="shield" size={14} />
        {status === 'approved' ? `Version ${version} is approved and frozen` : `Version ${version}, frozen as you see it`}
        {hash ? <> · <code title="The hash of the definition and the modules it pins">{hash.slice(0, 12)}</code></> : null}
      </p>
      <details className="caps-never">
        <summary>What it can never do ({caps.never.length})</summary>
        <ul className="caps-list">
          {caps.never.map((n) => (
            <li key={n}><span className="caps-icon"><Icon name="lock" size={16} /></span><span className="muted">{n}</span></li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/**
 * The summary in two parts: what the Flow is for, read first, and the step-by-step list folded under it. The rows
 * above say what approving allows; whoever wants the exact order opens this.
 */
function FlowSummary({ text }: { text: string }) {
  const lines = text.split('\n');
  const first = lines.findIndex((l) => /^\d+\. /.test(l.trim()));
  const head = (first === -1 ? lines : lines.slice(0, first)).join('\n').trim();
  const steps = first === -1 ? '' : lines.slice(first).join('\n').trim();
  return (
    <>
      {head ? <p className="summary">{head}</p> : null}
      {steps ? (
        <details>
          <summary className="muted">Step by step ({steps.split('\n').filter((l) => /^\d+\. /.test(l.trim())).length})</summary>
          <p className="summary">{steps}</p>
        </details>
      ) : null}
    </>
  );
}
