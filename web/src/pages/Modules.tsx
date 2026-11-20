import { useState } from 'react';
import { ArtifactJournal } from '../Journal';
import { api, post } from '../api';
import { Card, ChatBox, CodeView, Empty, ErrorText, Loading, Page, Pre, Status, useAction, useLoad, DraftSources, type DraftSource } from '../components';
import { useMe } from '../context';
import { Link, navigate } from '../router';
import { Icon, InfoTip, Notice, SearchField } from '../ui';
import { useTeams } from '../teams';
import { CATEGORY_LABELS, ClassificationPanel, needsAnswers, type Classification, type NeedsAnswers } from '../Classification';
import { TagPicker } from '../TagPicker';
import { DriftCard, ModuleDiffCard, RecordingsCard, SelfFixCard } from '../ModuleSafety';
import { AssistantNote, type AssistantDraft } from '../Mcp';
import { ChangeLinkCard } from '../Changes';
import { ModuleScore, type ModuleQuality } from '../DraftScore';
import { DraftModelPicker } from '../DraftModel';

interface ModuleItem { id: string; name: string; version: string; status: string; origin: string; manifest: { title: string; hosts: string[]; endpoints?: { protocol: string; host: string }[] }; createdBy: string | null; archived?: boolean }
/** HTTPS hosts and other connections (smtp://…, mqtt://…) of a module. */
const connections = (m: ModuleItem['manifest']) => [...m.hosts, ...(m.endpoints ?? []).map((e) => `${e.protocol}://${e.host}`)];
interface Review {
  id: string;
  ref: string;
  /** Flows of the person's teams that use this module (any version). */
  usedBy?: { flowId: string; name: string; version: number; status: string; uses: string | null }[];
  /** MODULE.md: what each action does and how to use it. */
  guide?: string;
  /** What each action is and does (written with the code; it does not run anything). */
  config?: unknown;
  /** The module's own TypeScript, without the Dittoly base above it. */
  ownSource?: string | null;
  status: string;
  origin: string;
  summary: string;
  manifest: unknown;
  validationReport: { passed: boolean; checks: { name: string; passed: boolean; details?: string[]; advisory?: boolean }[]; tests: { name: string; passed: boolean; errorType?: string; requests: string[]; expectOk?: boolean; live?: boolean; blocked?: string[] }[] } | null;
  /** What the draft is worth: security and performance findings, its tests, whether its settings are explained. */
  quality?: ModuleQuality | null;
  codeSha256: string;
  source: string | null;
  sourceSha256: string | null;
  generation: Generation | null;
}

interface Generation {
  source: { kind: string; url: string | null; sha256: string | null; bytes: number; fetchedAt: string | null; operations?: { total: number; included: number }; baseUrl: string | null; auth: string | null } | null;
  instructions: { text: string; sha256: string } | null;
  classification?: { summary: string; category: string; protocols: string[]; answers: Record<string, string>; missing?: string[] } | null;
  assistant?: AssistantDraft | null;
  fix?: { reason: string; fromVersion: string } | null;
  sources?: DraftSource[];
  /** Which AI wrote it, and how hard it was told to think. */
  by?: { provider: string; model: string | null; effort?: string | null } | null;
}

/** "anthropic:claude-opus-5:medium" — the one label that says which AI wrote a version. */
export function AiTag({ by }: { by?: { provider: string; model: string | null; effort?: string | null } | null }) {
  if (!by?.provider) return null;
  const label = [by.provider, by.model || 'unknown', by.effort].filter(Boolean).join(':');
  return (
    <span className="badge ai-tag" title={`Drafted by ${by.provider}${by.model ? `, model ${by.model}` : ''}${by.effort ? `, effort ${by.effort}` : ''}`}>
      <Icon name="sparkles" size={12} />{label}
    </span>
  );
}

interface Source { specUrl: string; docsUrl: string; docs: string; baseUrl: string; auth: string; authHeader: string }
const EMPTY_SOURCE: Source = { specUrl: '', docsUrl: '', docs: '', baseUrl: '', auth: '', authHeader: '' };

/** Only the fields the member filled in; undefined when none. */
function sourceBody(s: Source) {
  const out = Object.fromEntries(Object.entries(s).filter(([k, v]) => v.trim() && (k !== 'authHeader' || s.auth === 'header')));
  return Object.keys(out).length ? out : undefined;
}

/** Plain words for test outcomes reviewers often ask about; others show their code. */
const TEST_NOTES: Record<string, string> = {
  refused_by_input_schema: 'refused by the input schema, as expected (it never reaches the code)',
  test_input_invalid: "the test's own input does not fit the action's input schema",
  db_query_denied: 'the code asked for a query the manifest does not declare',
  effect_read_cannot_write: 'a read action tried to run a query that changes data',
  db_bad_param_type: 'a query parameter has the wrong type (values must be single strings, numbers, booleans or timestamps)',
  db_unknown_param: 'the code passed a parameter the query does not declare',
  db_missing_param: 'the code left out a parameter the query needs',
};

/** Why a test ended as it did: for a failure, what it expected and what happened instead. */
function testOutcome(t: { passed: boolean; errorType?: string; expectOk?: boolean }): string | null {
  const note = t.errorType ? (TEST_NOTES[t.errorType] ?? t.errorType) : null;
  if (t.passed || t.expectOk === undefined) return note;
  if (t.expectOk && note) return `expected to succeed, but it failed: ${note}`;
  if (!t.expectOk && !note) return 'expected an error, but it succeeded';
  return note;
}

/** Where a chat-built draft came from: the API source and the organization instructions the AI was given. */
export function GenerationCard({ generation }: { generation: Generation | null }) {
  if (generation?.fix) return <Card title={<><Icon name="sparkles"/>Where this draft came from</>}><div className="assistant-note" role="note"><p><Icon name="sparkles" size={14} /> Dittoly drafted this fix by itself because version <strong>{generation.fix.fromVersion}</strong> started failing the way it does when an app changes. Check it like any other draft.</p><p className="muted">What the AI was told:</p><Pre>{generation.fix.reason}</Pre></div></Card>;
  if (generation?.assistant) return <Card title={<><Icon name="sparkles"/>Where this draft came from</>}><AssistantNote draft={generation.assistant} what="module" /></Card>;
  if (!generation || (!generation.source && !generation.instructions && !generation.classification && !generation.sources?.length)) return null;
  const c = generation.classification;
  const s = generation.source;
  return (
    <Card title={<><Icon name="sparkles"/>What the AI was given</>}>
      {s ? (
        <p>
          API source: <strong>{s.kind === 'openapi' ? 'OpenAPI spec' : s.kind === 'docs' ? 'documentation page' : s.kind === 'pasted' ? 'pasted documentation' : 'base URL and auth only'}</strong>
          {s.url ? <> from <code>{s.url}</code></> : null}
          {s.operations ? <> ({s.operations.included} of {s.operations.total} operations, most relevant first)</> : null}
          {s.baseUrl ? <> · base URL <code>{s.baseUrl}</code></> : null}
          {s.auth ? <> · auth <code>{s.auth}</code></> : null}
          {s.sha256 ? <span className="muted"> · SHA-256 {s.sha256.slice(0, 12)}</span> : null}
        </p>
      ) : null}
      {c ? (
        <>
          <p>
            Classified as <strong>{CATEGORY_LABELS[c.category] ?? c.category}</strong>
            {c.protocols.length ? <> using <code>{c.protocols.join(', ')}</code></> : null}. {c.summary}
          </p>
          {c.missing?.length ? <p className="muted">Built anyway, although no approved module could: {c.missing.join(', ')}.</p> : null}
          {Object.keys(c.answers).length ? (
            <ul>
              {Object.entries(c.answers).map(([question, a]) => (
                <li key={question}>
                  {question} <strong>{a}</strong>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {generation.instructions ? (
        <>
          <p className="muted">Organization instructions in effect:</p>
          <Pre>{generation.instructions.text}</Pre>
        </>
      ) : null}
      <h3>Sources</h3>
      <DraftSources sources={generation.sources} />
      <p className="muted">These guide the draft only. What the module may do is the manifest above, enforced at run time.</p>
    </Card>
  );
}

/** Paste a Playwright test or script: it becomes a browser module, checked live against the sites it visits. */
function PlaywrightCard() {
  const act = useAction();
  const [f, setF] = useState({ name: '', title: '', script: '', hosts: '' });
  return (
    <Card title={<><Icon name="bolt"/>Paste a Playwright Script</>} actions={<span className="badge tone-info">Browser</span>}>
      <p className="muted">
        Each <code>test(…)</code> becomes an action you can put in a Flow. It runs in a headless browser that may open only the sites the script visits (and any you add),
        and is run once against them now. An admin reviews it before use. Scripts that sign in or submit data: describe them to the AI instead, so your login stays in your vault.
      </p>
      <form
        className="form-grid"
        onSubmit={(e) => {
          e.preventDefault();
          act.run(async () => {
            const r = await post<Review>('/modules/import-playwright', {
              name: f.name,
              title: f.title || f.name,
              script: f.script,
              hosts: f.hosts.split(/[\s,]+/).filter(Boolean),
            });
            navigate(`/modules/${r.id}`);
          });
        }}
      >
        <div className="field">
          <label htmlFor="pw-script">Script</label>
          <textarea id="pw-script" rows={8} className="mono" placeholder={"test('has title', async ({ page }) => {\n  await page.goto('https://example.com/');\n  await expect(page).toHaveTitle(/Example/);\n});"} value={f.script} onChange={(e) => setF({ ...f, script: e.target.value })} required />
        </div>
        <div className="field">
          <label htmlFor="pw-name">Module name</label>
          <input id="pw-name" placeholder="shop-smoke-test" pattern="[a-z][a-z0-9-]{1,39}" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        </div>
        <div className="field">
          <label htmlFor="pw-title">Title</label>
          <input id="pw-title" placeholder="Shop smoke test" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="pw-hosts">Other sites its pages need (CDNs), optional</label>
          <input id="pw-hosts" placeholder="cdn.example.com, *.fonts.example.com" value={f.hosts} onChange={(e) => setF({ ...f, hosts: e.target.value })} />
        </div>
        <div>
          <button type="submit" disabled={act.busy}>{act.busy ? 'Running it once…' : 'Create browser module'}</button>
        </div>
        <ErrorText>{act.error}</ErrorText>
      </form>
    </Card>
  );
}

export function Modules() {
  const { me, mode } = useMe();
  const list = useLoad(() => api<ModuleItem[]>('/modules'));
  const act = useAction();
  const [mcp, setMcp] = useState({ url: '', name: '', title: '', credentialService: '', transport: 'http', pkg: '', hosts: '', credentialEnv: '' });
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState<Source>(EMPTY_SOURCE);
  const [showSource, setShowSource] = useState(false);
  // A request from the Flow builder ("Build this module") starts the box.
  const [initialRequest] = useState(() => new URLSearchParams(location.search).get('request') ?? '');
  const [pending, setPending] = useState<{ request: string; classification: Classification } | null>(null);
  const generate = (request: string, answers?: Record<string, string>) =>
    act.run(async () => {
      const r = await post<Review | NeedsAnswers>('/modules/generate', { request, source: sourceBody(source), ...(answers ? { answers } : {}) });
      if (needsAnswers(r)) setPending({ request, classification: r.classification });
      else navigate(`/modules/${r.id}`);
    });
  // Deleted (archived) modules show only under the "Deleted" filter, where an admin restores them.
  const filtered = list.data?.filter(m => `${m.name} ${m.manifest.title} ${connections(m.manifest).join(' ')}`.toLowerCase().includes(q.toLowerCase()) && (status === 'deleted' ? m.archived : !m.archived && (!status || m.status === status)));

  return (
    <Page title="Modules" eyebrow="CONTROL PLANE / INTEGRATIONS" description="Connections to your apps. Describe one and the AI drafts it, or import an MCP server. An admin reviews what each may access before any Flow uses it." className="modules-page">
      <div className="grid">
        <Card title={<><Icon name="sparkles"/>Describe a New Integration</>} actions={<span className="badge tone-info">AI synthesis</span>}>
          <p className="muted">The AI writes the module and its manifest; Dittoly tests it in the sandbox; an admin reviews what it may do before anyone can use it.</p>
          {pending ? (
            <ClassificationPanel c={pending.classification} busy={act.busy} onBuild={(answers) => generate(pending.request, answers)} onCancel={() => setPending(null)} />
          ) : (
            <ChatBox
              placeholder="e.g. GitHub: list open pull requests in a repository and add a comment"
              button="Draft module"
              suggestions={['GitHub: list pull requests and add a comment', 'Email the team through our SMTP server when a release ships']}
              busy={act.busy}
              initial={initialRequest}
              onSubmit={(text) => generate(text)}
            />
          )}
          <button type="button" className="ghost" aria-expanded={showSource} onClick={() => setShowSource(!showSource)}>
            {showSource ? 'Hide API source' : 'Add API source (spec, docs, base URL)'}
          </button>
          {showSource ? (
            <div className="form-grid">
              <p className="muted">The AI builds from this instead of memory. Links are fetched by the server; nothing in them is treated as an instruction.</p>
              <div className="field"><label htmlFor="src-spec">OpenAPI / Swagger spec URL</label><input id="src-spec" type="url" placeholder="https://api.example.com/openapi.json" value={source.specUrl} onChange={(e) => setSource({ ...source, specUrl: e.target.value, docsUrl: e.target.value ? '' : source.docsUrl })} /></div>
              <div className="field"><label htmlFor="src-docs-url">or documentation page URL</label><input id="src-docs-url" type="url" placeholder="https://developer.example.com/api" value={source.docsUrl} disabled={!!source.specUrl} onChange={(e) => setSource({ ...source, docsUrl: e.target.value })} /></div>
              <div className="field"><label htmlFor="src-docs">or paste documentation / a spec</label><textarea id="src-docs" rows={4} value={source.docs} disabled={!!(source.specUrl || source.docsUrl)} onChange={(e) => setSource({ ...source, docs: e.target.value })} /></div>
              <div className="field"><label htmlFor="src-base">Base URL</label><input id="src-base" type="url" placeholder="https://api.example.com/v1" value={source.baseUrl} onChange={(e) => setSource({ ...source, baseUrl: e.target.value })} /></div>
              <div className="field"><label htmlFor="src-auth">Authentication</label>
                <select id="src-auth" value={source.auth} onChange={(e) => setSource({ ...source, auth: e.target.value })}>
                  <option value="">Let the AI work it out</option><option value="bearer">Bearer token</option><option value="header">API key in a header</option><option value="basic">Basic (user:password)</option><option value="oauth">OAuth</option><option value="none">None</option>
                </select>
              </div>
              {source.auth === 'header' ? <div className="field"><label htmlFor="src-header">Header name</label><input id="src-header" placeholder="X-Api-Key" value={source.authHeader} onChange={(e) => setSource({ ...source, authHeader: e.target.value })} /></div> : null}
            </div>
          ) : null}
        </Card>
        <Card title={<><Icon name="layers"/>Import an MCP Server</>} actions={<span className="badge tone-info">{mcp.transport === 'stdio' ? 'Sandboxed' : 'HTTPS only'}</span>}>
          {mode === 'local' ? (
            <div className="field">
              <label htmlFor="mcp-transport">Server type</label>
              <select id="mcp-transport" value={mcp.transport} onChange={(e) => setMcp({ ...mcp, transport: e.target.value })}>
                <option value="http">Remote (HTTPS URL)</option>
                <option value="stdio">Local package (npm), runs in a Docker sandbox</option>
              </select>
            </div>
          ) : null}
          <p className="muted">
            {mcp.transport === 'stdio'
              ? 'The package is installed with install scripts disabled and runs in a container that can only reach the hosts you list. Unlike a module, the server program can read its token. Needs Docker.'
              : 'Remote (HTTPS) MCP servers. Its tools become a module that an admin reviews.'}
          </p>
          <form
            className="form-grid"
            onSubmit={(e) => {
              e.preventDefault();
              act.run(async () => {
                const common = { name: mcp.name, ...(mcp.title ? { title: mcp.title } : {}), ...(mcp.credentialService ? { credentialService: mcp.credentialService } : {}) };
                const body =
                  mcp.transport === 'stdio'
                    ? {
                        ...common,
                        transport: 'stdio',
                        package: mcp.pkg.trim(),
                        hosts: mcp.hosts.split(/[\s,]+/).filter(Boolean),
                        ...(mcp.credentialService ? { credentialEnv: mcp.credentialEnv } : {}),
                      }
                    : { ...common, url: mcp.url };
                navigate(`/modules/${(await post<Review>('/mcp/import', body)).id}`);
              });
            }}
          >
            {mcp.transport === 'stdio' ? (
              <>
                <div className="field">
                  <label htmlFor="mcp-pkg">npm package, with an exact version</label>
                  <input id="mcp-pkg" placeholder="example-mcp-server@1.2.3" value={mcp.pkg} onChange={(e) => setMcp({ ...mcp, pkg: e.target.value })} required />
                </div>
                <div className="field">
                  <label htmlFor="mcp-hosts">Hosts it may reach (host or host:port, port 443 by default)</label>
                  <input id="mcp-hosts" placeholder="api.example.com" value={mcp.hosts} onChange={(e) => setMcp({ ...mcp, hosts: e.target.value })} />
                </div>
              </>
            ) : (
              <div className="field">
                <label htmlFor="mcp-url">Server URL</label>
                <input id="mcp-url" type="url" placeholder="https://mcp.example.com/mcp" value={mcp.url} onChange={(e) => setMcp({ ...mcp, url: e.target.value })} required />
              </div>
            )}
            <div className="field">
              <label htmlFor="mcp-name">Module name</label>
              <input id="mcp-name" placeholder="docs" pattern="[a-z][a-z0-9-]{1,39}" value={mcp.name} onChange={(e) => setMcp({ ...mcp, name: e.target.value })} required />
            </div>
            <div className="field">
              <label htmlFor="mcp-cred">Credential name in your vault (if the server needs a token)</label>
              <input id="mcp-cred" placeholder="docs" value={mcp.credentialService} onChange={(e) => setMcp({ ...mcp, credentialService: e.target.value })} />
            </div>
            {mcp.transport === 'stdio' && mcp.credentialService ? (
              <div className="field">
                <label htmlFor="mcp-env">Environment variable the server reads the token from</label>
                <input id="mcp-env" placeholder="EXAMPLE_API_TOKEN" pattern="[A-Z_][A-Z0-9_]{0,63}" value={mcp.credentialEnv} onChange={(e) => setMcp({ ...mcp, credentialEnv: e.target.value })} required />
              </div>
            ) : null}
            <div>
              <button type="submit" disabled={act.busy}>
                {act.busy && mcp.transport === 'stdio' ? 'Installing…' : 'Import'}
              </button>
            </div>
          </form>
        </Card>
        <PlaywrightCard />
      </div>
      <ErrorText>{act.error}</ErrorText>
      {me.role === 'admin' ? <><DriftCard /><SelfFixCard /></> : null}
      <Notice><strong>Reviewed integrations, explicit boundaries.</strong> Modules declare their permitted hosts and actions. Generated integrations run through sandbox validation before admin approval.</Notice>
      <div className="toolbar"><SearchField value={q} onChange={setQ} placeholder="Filter modules by name or host…"/><select aria-label="Module status" value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option><option value="approved">Approved</option><option value="pending_review">Pending review</option><option value="draft">Draft</option><option value="rejected">Rejected</option><option value="deleted">Deleted</option></select></div>
      <Card title="Module Manifests & Versions" actions={<span className="badge tone-info">{filtered?.length ?? 0} versions</span>}>
        {!list.data ? (
          <Loading />
        ) : filtered?.length === 0 ? (
          <Empty>{list.data.length ? "No modules match your filters." : "No modules yet. Describe an app to connect, or import an MCP server, above."}</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Module</th>
                  <th>Status</th>
                  <th>Hosts</th>
                  <th>Origin</th>
                </tr>
              </thead>
              <tbody>
                {filtered?.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <Link to={`/modules/${m.id}`}>
                        {m.manifest.title} {m.version}
                      </Link>
                      {m.createdBy === me.id ? <span className="muted"> · yours</span> : null}
                    </td>
                    <td>
                      {m.archived ? (
                        <span className="row">
                          <span className="badge tone-warn">deleted</span>
                          {me.role === 'admin' ? (
                            <button type="button" className="ghost" disabled={act.busy} onClick={() => act.run(async () => { await post(`/modules/by-name/${encodeURIComponent(m.name)}/restore`); list.reload(); }, `Module ${m.name} restored`)}>Restore</button>
                          ) : null}
                        </span>
                      ) : <Status value={m.status} />}
                    </td>
                    <td>{connections(m.manifest).join(', ')}</td>
                    <td className="muted">{m.origin}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <ErrorText>{act.error}</ErrorText>
      </Card>
    </Page>
  );
}

/**
 * Delete a module: every version of it is archived. It leaves the lists and the catalog and no Flow can run it;
 * its history stays and an admin can restore it. Refused while a Flow uses it (the message lists them).
 */
function DeleteModule({ name }: { name: string }) {
  const act = useAction();
  return (
    <Card title="Delete this module">
      <p className="muted">Removes every version of <code>{name}</code> from the lists and the catalog; nothing can run it. Its versions and history are kept, and an admin can restore it under Modules → Deleted.</p>
      <div className="row">
        <button
          type="button"
          className="danger"
          disabled={act.busy}
          onClick={() => {
            if (!confirm(`Delete the module "${name}" (every version)?`)) return;
            act.run(async () => { await api(`/modules/by-name/${encodeURIComponent(name)}`, { method: 'DELETE' }); navigate('/modules'); }, `Module ${name} deleted`);
          }}
        >
          Delete module
        </button>
      </div>
      <ErrorText>{act.error}</ErrorText>
    </Card>
  );
}

export function ModuleReview({ id }: { id: string }) {
  const { me } = useMe();
  const r = useLoad(() => api<Review>(`/modules/${id}/review`), [id]);
  const act = useAction();
  const [tags, setTags] = useState<string[]>([]);
  if (r.error) return <ErrorText>{r.error}</ErrorText>;
  if (!r.data) return <Loading />;
  const m = r.data;
  const report = m.validationReport;
  return (
    <Page title={m.ref} eyebrow="SUPER-MODULE STUDIO / MANIFEST REVIEW" actions={<><AiTag by={m.generation?.by} /><Status value={m.status} /></>}>
      {m.quality ? (
        <Card title="What this draft is worth">
          <ModuleScore q={m.quality} />
          <p className="muted">
            The same reading the AI was asked to fix while it drafted, and the one the model comparison counts.
          </p>
        </Card>
      ) : null}
      <ArtifactJournal type="module" id={m.ref.slice(0, m.ref.lastIndexOf('@'))} />
      <Card title="Which AI writes this module">
        <p>
          <DraftModelPicker type="module" id={m.ref.slice(0, m.ref.lastIndexOf('@'))} what="this module" />{' '}
          <span className="muted">Whoever wrote a version of it, or an admin. With no choice of its own it follows yours, then the organization's.</span>
        </p>
        <p className="muted">A module never uses AI when it runs: it is plain code in the sandbox. This is only who writes the next version of it.</p>
      </Card>
      <Card title="What this module may do">
        <p className="summary">{m.summary}</p>
        <p className="muted">The runtime enforces this: the module can reach only these hosts and is given only these credentials.</p>
      </Card>
      <ChangeLinkCard moduleVersionId={id} />
      <Card title="Used by">
        {m.usedBy?.length ? (
          <ul className="list" aria-label="Flows that use this module">
            {m.usedBy.map((f) => (
              <li key={f.flowId}>
                <Link to={`/flows/${f.flowId}`}>{f.name}</Link> <span className="muted">v{f.version} · {f.status.replace(/_/g, ' ')}{f.uses ? <> · uses <code>{f.uses}</code></> : null}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No Flow of your teams uses this module yet.</p>
        )}
      </Card>
      <ModuleDiffCard id={id} />
      <ModuleSettingsCard manifest={m.manifest as { settings?: Setting[] }} />
      <ActionIoCard ref_={m.ref} manifest={m.manifest as { actions?: ActionSpec[]; settings?: Setting[] }} />
      {m.status === 'approved' ? (
        <Card title={<><Icon name="flow" />Use in a Flow</>}>
          <p className="muted">Say what should happen, and the AI drafts a Flow around this module. The Flow is a draft until an approver approves it.</p>
          <Link to={`/flows?module=${encodeURIComponent(m.ref.slice(0, m.ref.lastIndexOf('@')))}`} className="button primary">Draft a Flow with this module</Link>
        </Card>
      ) : null}
      {m.status === 'approved' && m.origin !== 'mcp' ? <RecordingsCard id={id} manifest={m.manifest as Parameters<typeof RecordingsCard>[0]['manifest']} /> : null}
      <GenerationCard generation={m.generation} />
      {report ? (
        <Card title="Sandbox test report" actions={<Status value={report.passed ? 'succeeded' : 'failed'} />}>
          {report.checks.some((c) => c.name.startsWith('OWASP')) ? (
            <p className="muted">The OWASP checks look for the OWASP Top 10 (2025) risks in the code. A hard-coded secret fails the module; warnings are for you to read before approving.</p>
          ) : null}
          <ul className="list">
            {report.checks.map((c) => (
              <li key={c.name}>
                {!c.passed && c.advisory ? <span className="badge tone-warn">warning</span> : <Status value={c.passed ? 'succeeded' : 'failed'} />} {c.name}
                {c.details?.length ? <span className="muted">— {c.details.join('; ')}</span> : null}
              </li>
            ))}
            {report.tests.map((t) => (
              <li key={t.name}>
                <Status value={t.passed ? 'succeeded' : 'failed'} /> test: {t.name}
                {testOutcome(t) ? <span className="muted">— {testOutcome(t)}</span> : null}
                {t.requests.length ? <span className="muted">· {t.requests.join(', ')}</span> : null}
                {t.live ? <span className="badge tone-info">ran against the real site</span> : null}
                {t.blocked?.length ? <span className="muted">· blocked: {t.blocked.join(', ')}</span> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {me.role === 'admin' ? <DeleteModule name={m.ref.slice(0, m.ref.lastIndexOf('@'))} /> : null}
      <Card title="Decision">
        {m.status === 'draft' ? (
          <div className="row">
            <button className="primary" disabled={act.busy || !report?.passed} onClick={() => act.run(async () => (await post(`/modules/${id}/submit`), r.reload()), 'Submitted for admin review')}>
              Submit for admin review
            </button>
            {!report?.passed ? <span className="muted">Fix the failing checks first (ask for a revision).</span> : null}
          </div>
        ) : null}
        {m.status === 'pending_review' && me.role === 'admin' ? (
          <div className="row">
            <button className="primary" disabled={act.busy} onClick={() => act.run(async () => (await post(`/modules/${id}/decision`, { decision: 'approved' }), r.reload()), 'Module approved')}>
              Approve
            </button>
            <button className="danger" disabled={act.busy} onClick={() => act.run(async () => (await post(`/modules/${id}/decision`, { decision: 'rejected' }), r.reload()), 'Module rejected')}>
              Reject
            </button>
          </div>
        ) : null}
        {m.status === 'approved' && me.role === 'admin' ? (
          <div className="publish-box">
            <TagPicker value={tags} onChange={setTags} suggestFor={{ moduleVersionId: id }} ai={{ title: String((m.manifest as { title?: string }).title ?? ''), summary: String((m.manifest as { description?: string }).description ?? '') }} />
            <button
              disabled={act.busy}
              onClick={() =>
                act.run(() =>
                  post('/marketplace/modules', {
                    moduleVersionId: id,
                    tags,
                  }),
                  'Listed in the marketplace',
                )
              }
            >
              List in marketplace
            </button>
          </div>
        ) : null}
        {m.status === 'draft' && m.origin === 'chat' ? (
          <ChatBox
            placeholder="What should change? (creates a new version)"
            button="Revise"
            busy={act.busy}
            onSubmit={(text) => act.run(async () => navigate(`/modules/${(await post<Review>(`/modules/${id}/revise`, { feedback: text })).id}`), 'Revision drafted')}
          />
        ) : null}
        <ErrorText>{act.error}</ErrorText>
      </Card>
      <Card>
        {m.guide ? (
          <details open>
            <summary>MODULE.md: its actions and how to use them</summary>
            <div className="guide pre-wrap">{m.guide}</div>
          </details>
        ) : null}
        {m.config ? (
          <details>
            <summary>Config: what each action is and does</summary>
            <CodeView code={JSON.stringify(m.config, null, 2)} label="config.json" />
          </details>
        ) : null}
        <details>
          <summary>Manifest</summary>
          <CodeView code={JSON.stringify(m.manifest, null, 2)} label="manifest.json" />
        </details>
        {m.ownSource ? (
          <>
            <details>
              <summary>Code (TypeScript): the module's own part</summary>
              <CodeView code={m.ownSource} label="module.ts" />
            </details>
            <details>
              <summary>Whole module.ts, with the Dittoly base on top (the same in every module)</summary>
              <CodeView code={m.source ?? ''} label="module.ts (with base)" />
            </details>
          </>
        ) : m.source !== null ? (
          <details>
            <summary>Code (TypeScript)</summary>
            <CodeView code={m.source} label="module.ts" />
          </details>
        ) : null}
        {m.sourceSha256 ? <p className="muted">TypeScript fingerprint (SHA-256): {m.sourceSha256}</p> : null}
        <p className="muted">{m.source !== null ? 'Compiled code fingerprint, what runs' : 'Code fingerprint'} (SHA-256): {m.codeSha256}</p>
      </Card>
    </Page>
  );
}

interface Setting { id: string; type: 'host' | 'text' | 'certificate'; label: string; pattern?: string; default?: string; help?: string; example?: string }

/** What a module needs to be told (e.g. the Jira site). A module keeps no values: each Flow gives its own. */
function ModuleSettingsCard({ manifest }: { manifest: { settings?: Setting[] } }) {
  const declared = manifest.settings ?? [];
  if (!declared.length) return null;
  return (
    <Card title="What it needs to be told">
      <p className="muted">
        This module keeps no values of its own. Every Flow that uses it gives these in its own definition, so two
        Flows can use two different sites, and the approver sees which one a Flow uses.
      </p>
      <ul className="list">
        {declared.map((st) => (
          <li key={st.id}>
            <code>{st.id}</code> — {st.label}
            {st.type === 'host' ? <span className="muted"> (a host matching {st.pattern})</span> : null}
            {st.help ? <span className="muted"> · {st.help}</span> : null}
            {st.example ?? st.default ? <span className="muted"> · for example {st.example ?? st.default}</span> : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface FieldSchema {
  type?: string | string[];
  description?: string;
  examples?: unknown[];
  enum?: unknown[];
  default?: unknown;
  items?: FieldSchema;
  properties?: Record<string, FieldSchema>;
  required?: string[];
}
interface ActionSpec { name: string; title: string; description: string; effect: 'read' | 'write'; input?: FieldSchema; output?: FieldSchema; credentials?: string[] }

/** "text", "list of text", "object": the shape of one field, said plainly. */
function shapeOf(f: FieldSchema): string {
  const t = Array.isArray(f.type) ? f.type.join(' or ') : f.type;
  if (t === 'array') return `list of ${f.items ? shapeOf(f.items) : 'values'}`;
  if (t === 'string' && f.enum?.length) return `one of ${f.enum.slice(0, 6).map(String).join(', ')}`;
  return t ?? (f.properties ? 'object' : 'any value');
}
const fieldsOf = (schema: FieldSchema | undefined) => Object.entries(schema?.properties ?? {});
const exampleFor = (name: string, f: FieldSchema): unknown =>
  f.examples?.[0] ?? f.default ?? f.enum?.[0] ?? (shapeOf(f).startsWith('list') ? [`{{ inputs.${name} }}`] : `{{ inputs.${name} }}`);

/**
 * What each action takes and gives back, and the step a Flow writes to send it: a module is stateless, so
 * everything it works with arrives as the action's input (or as what the Flow tells it, above).
 */
function ActionIoCard({ ref_, manifest }: { ref_: string; manifest: { actions?: ActionSpec[]; settings?: Setting[] } }) {
  const actions = manifest.actions ?? [];
  const [open, setOpen] = useState(actions[0]?.name ?? '');
  const chosen = actions.find((a) => a.name === open) ?? actions[0];
  if (!chosen) return null;
  const name = ref_.slice(0, ref_.lastIndexOf('@')) || ref_;
  const inputs = fieldsOf(chosen.input);
  const outputs = fieldsOf(chosen.output);
  const required = new Set(chosen.input?.required ?? []);
  const step = {
    id: chosen.name,
    type: 'action',
    module: ref_,
    action: chosen.name,
    input: Object.fromEntries(inputs.filter(([k]) => required.has(k) || inputs.length <= 4).map(([k, f]) => [k, exampleFor(k, f)])),
  };
  const told = manifest.settings?.length
    ? { moduleSettings: { [name]: Object.fromEntries(manifest.settings.map((st) => [st.id, st.example ?? st.default ?? ''])) } }
    : null;
  return (
    <Card
      title={<><Icon name="flow" />What each action takes, and what it gives back</>}
      actions={<span className="badge">{actions.length} action{actions.length === 1 ? '' : 's'}</span>}
    >
      <p className="muted">
        This module keeps nothing: everything it works with arrives with the call. A Flow step gives the action's
        input — a literal value, or a template that takes it from the run form (<code>{'{{ inputs.x }}'}</code>) or from
        an earlier step (<code>{'{{ steps.<id>.output.y }}'}</code>). What the action answers becomes
        <code>{' {{ steps.<id>.output.… }}'}</code> for the steps after it.
      </p>
      {actions.length > 1 ? (
        <div className="field">
          <label htmlFor="mod-action">Action</label>
          <select id="mod-action" value={chosen.name} onChange={(e) => setOpen(e.target.value)}>
            {actions.map((a) => <option key={a.name} value={a.name}>{a.title}{a.effect === 'write' ? ' (changes data)' : ''}</option>)}
          </select>
        </div>
      ) : null}
      <div className="row">
        <strong>{chosen.title}</strong>
        <code>{chosen.name}</code>
        {chosen.effect === 'write' ? <span className="badge tone-warn">Changes data</span> : <span className="badge">Reads only</span>}
        {chosen.credentials?.length ? <span className="muted">needs the runner's {chosen.credentials.join(', ')} access</span> : <span className="muted">no key needed</span>}
      </div>
      <p>{chosen.description}</p>
      <h3>It takes</h3>
      {inputs.length ? (
        <ul className="list" aria-label="What the action takes">
          {inputs.map(([k, f]) => (
            <li key={k}>
              <code>{k}</code> <span className="muted">{shapeOf(f)}{required.has(k) ? ' · required' : ' · optional'}</span>
              {f.description ? <span className="muted"> — {f.description}</span> : null}
              {f.examples?.length ? <span className="muted"> · for example {JSON.stringify(f.examples[0])}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing: the Flow calls it with an empty input.</p>
      )}
      <h3>It gives back</h3>
      {outputs.length ? (
        <ul className="list" aria-label="What the action gives back">
          {outputs.map(([k, f]) => (
            <li key={k}>
              <code>{`{{ steps.<id>.output.${k} }}`}</code> <span className="muted">{shapeOf(f)}</span>
              {f.description ? <span className="muted"> — {f.description}</span> : null}
              {f.items?.properties ? <span className="muted"> · each item has {Object.keys(f.items.properties).slice(0, 8).join(', ')}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing a later step can read.</p>
      )}
      <h3>How a Flow sends it</h3>
      <CodeView
        code={`${told ? `${JSON.stringify(told, null, 2).slice(1, -1).trim()},\n` : ''}"steps": [\n${JSON.stringify(step, null, 2)
          .split('\n')
          .map((l) => `  ${l}`)
          .join('\n')}\n]`}
        label="in the Flow definition"
      />
      <p className="muted">
        Replace each <code>{'{{ inputs.… }}'}</code> with a real value, a run-form input, or an earlier step's
        output. A list output is walked with <code>"forEach"</code>, and inside it each element is <code>{'{{ item.… }}'}</code>.
      </p>
    </Card>
  );
}
