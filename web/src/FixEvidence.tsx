import { Pre } from './components';
import { Icon } from './ui';

/**
 * Fix and verify: what Dittoly checked itself (run page), and what the approver agrees to
 * (review page): where secret env vars come from, the change's limits, the confidence a push
 * without a person needs, and which steps an evidence gate lets go on by themselves.
 */

export interface FixOutput {
  verified: {
    buildOk: boolean;
    reproducedBefore: boolean | null;
    regressionTestFailsBefore: boolean | null;
    regressionTestPassesAfter: boolean | null;
    reproducedAfter: boolean | null;
    testsPassAfter: boolean;
  };
  limits: { ok: boolean; violations: string[] };
  confidence: { score: number; level: 'high' | 'medium' | 'low'; reasons: string[] };
  change: { files: { path: string; action: 'create' | 'update' | 'delete' }[]; diff: string; filesChanged: number; linesAdded: number; linesRemoved: number };
  summary: string;
  regressionTest: string | null;
  autoPushAllowed: boolean;
  /** What each phase could reach and got, and what was refused (runs since plan item 08). */
  network?: NetworkReport;
}

export interface NetworkReport {
  mode: 'docker' | 'direct';
  phases: { phase: string; reaches: string[]; secrets: string[] }[];
  refused: { phase: string; host: string; reason: string }[];
}

const REFUSED: Record<string, string> = { not_allowed: 'not declared for this phase', unresolved: 'the name did not resolve', private_address: 'a private address not listed as internal' };

/** An app or fix step's network evidence: per phase, what it could reach and which secrets it got; what was refused. */
export function NetworkEvidence({ report }: { report: NetworkReport }) {
  return (
    <details>
      <summary>
        Network: {report.mode === 'direct' ? "this machine's full network (direct mode)" : 'per phase, through its own proxy'}
        {report.refused.length ? ` · ${report.refused.length} connection${report.refused.length === 1 ? '' : 's'} refused` : ''}
      </summary>
      <ul className="list">
        {report.phases.map((p) => (
          <li key={p.phase}>
            <strong>{p.phase}</strong>: {p.reaches.length ? p.reaches.join(', ') : 'nothing outside'}
            {p.secrets.length ? <> · secrets {p.secrets.map((n) => <code key={n}>{n} </code>)}</> : null}
          </li>
        ))}
        {report.refused.map((r) => (
          <li key={r.phase + r.host + r.reason} className="tone-bad">
            Refused in {r.phase}: {r.host} ({REFUSED[r.reason] ?? r.reason})
          </li>
        ))}
      </ul>
    </details>
  );
}

export const isFixOutput = (v: unknown): v is FixOutput => !!v && typeof v === 'object' && 'verified' in v && 'confidence' in v && 'change' in v;

const TONE = { high: 'tone-ok', medium: 'tone-warn', low: 'tone-bad' } as const;

function Check({ ok, label }: { ok: boolean | null; label: string }) {
  return (
    <li>
      <span className={ok === null ? 'muted' : ok ? 'tone-ok' : 'tone-bad'} aria-label={ok === null ? 'not checked' : ok ? 'passed' : 'failed'}>
        {ok === null ? '–' : ok ? '✓' : '✗'}
      </span>{' '}
      {label}
    </li>
  );
}

/** The run page: the evidence Dittoly gathered, the confidence it computed, the limits and the diff. */
export function FixEvidence({ output }: { output: FixOutput }) {
  const v = output.verified;
  const c = output.change;
  return (
    <div className="stack" aria-label="Fix evidence">
      <div className="row">
        <span className={`badge ${TONE[output.confidence.level]}`}>Confidence {output.confidence.score} ({output.confidence.level})</span>
        <span className={`badge ${output.limits.ok ? 'tone-ok' : 'tone-bad'}`}>{output.limits.ok ? 'Inside its limits' : 'Outside its limits'}</span>
        <span className={`badge ${output.autoPushAllowed ? 'tone-ok' : 'tone-warn'}`}>{output.autoPushAllowed ? 'May be pushed without a person' : 'A person decides before it is pushed'}</span>
      </div>
      <p className="muted">Checked by Dittoly with its own runs, not taken from the AI:</p>
      <ul className="list">
        <Check ok={v.reproducedBefore} label="The reproduce command failed before the change (the bug was there)" />
        <Check ok={v.regressionTestFailsBefore} label={`The regression test${output.regressionTest ? ` (${output.regressionTest})` : ''} fails on the original code`} />
        <Check ok={v.buildOk} label="The build works with the change" />
        <Check ok={v.regressionTestPassesAfter} label="The regression test passes with the change" />
        <Check ok={v.reproducedAfter === null ? null : !v.reproducedAfter} label="The reproduce command passes with the change" />
        <Check ok={c.filesChanged ? v.testsPassAfter : null} label="The test suite passes with the change" />
      </ul>
      {output.limits.violations.length ? (
        <div className="stack">
          <strong>Limits broken</strong>
          <ul className="list">
            {output.limits.violations.map((x) => (
              <li key={x} className="tone-bad">{x}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {output.summary ? (
        <p>
          <span className="muted">The AI&apos;s own summary (does not change the score):</span> {output.summary}
        </p>
      ) : null}
      {c.filesChanged ? (
        <details>
          <summary>
            The change: {c.filesChanged} file{c.filesChanged === 1 ? '' : 's'}, +{c.linesAdded} −{c.linesRemoved} ({c.files.map((f) => `${f.action} ${f.path}`).join(', ')})
          </summary>
          <Pre>{c.diff}</Pre>
        </details>
      ) : (
        <p className="muted">The AI made no change.</p>
      )}
      {output.network ? <NetworkEvidence report={output.network} /> : null}
    </div>
  );
}

interface ReviewStep {
  id: string;
  type: string;
  secretEnv?: Record<string, string | { service: string; phases: string[] }>;
  limits?: { blockedPaths?: string[]; addBlockedPaths?: string[]; allowRiskyPaths?: boolean; maxFiles?: number; maxLinesChanged?: number; onlyFilesIn?: string | string[] };
  autoPushAt?: number;
  test?: string;
  reproduce?: string;
}
export interface EvidenceGate { step: string; rule: string; fixStep: string | null; autoPushAt: number | null; otherSources: string[] }

/** The review page: evidence gates first (they let a change go on without a person), then each fix and app step's secrets and limits. */
export function FixReview({ steps, gates }: { steps: ReviewStep[]; gates: EvidenceGate[] }) {
  const built = steps.filter((s) => s.type === 'fix' || (s.type === 'app' && Object.keys(s.secretEnv ?? {}).length));
  if (!built.length && !gates.length) return null;
  return (
    <div className="stack" aria-label="Fix and verify">
      {gates.map((g) => (
        <div key={g.step} className="notice" role="note">
          <Icon name="shield" size={16} />
          <div>
            <strong>
              Step {g.step} pushes automatically when the fix is verified; otherwise it asks a person.
            </strong>{' '}
            Its sign-off is released only when Dittoly&apos;s own checks of step {g.fixStep}&apos;s change hold (<code>{g.rule}</code>
            {g.autoPushAt !== null ? `: confidence ${g.autoPushAt} or more, inside its limits, tests passing, the bug shown before the change` : ': never, as that fix step sets no autoPushAt'}).
            {g.otherSources.length ? ` Text from ${g.otherSources.join(', ')} also reaches it, so it asks a person in runs where ${g.otherSources.length > 1 ? 'one of them runs' : 'that step runs'}.` : ''}
          </div>
        </div>
      ))}
      {built.map((s) => {
        const env = Object.entries(s.secretEnv ?? {});
        const l = s.limits ?? {};
        return (
          <div key={s.id} className="stack">
            <h2>
              <Icon name="shield" size={16} />
              {s.type === 'fix' ? `Fix and verify: step ${s.id}` : `App step ${s.id}`}
            </h2>
            {env.length ? (
              <table>
                <thead>
                  <tr><th>Secret env var</th><th>From the credential</th><th>Reaches</th></tr>
                </thead>
                <tbody>
                  {env.map(([name, v]) => (
                    <tr key={name}>
                      <td><code>{name}</code></td>
                      <td><code>{typeof v === 'string' ? v : v.service}</code> (the team&apos;s stored one, else the runner&apos;s own; never shown)</td>
                      <td>{(typeof v === 'string' ? (s.type === 'fix' ? ['build', 'test'] : ['build', 'run']) : v.phases).join(', ')} (never the install)</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            {s.type === 'fix' ? (
              <ul className="list">
                <li>Checks: tests <code>{s.test}</code>{s.reproduce ? <> and reproduce <code>{s.reproduce}</code></> : ' (no reproduce command: the AI must add a regression test)'}</li>
                <li>
                  Limits: at most {l.maxFiles ?? 5} files and {l.maxLinesChanged ?? 200} changed lines;{' '}
                  {l.blockedPaths ? <>blocked: <code>{l.blockedPaths.join(', ')}</code></> : 'CI/CD, dependency, build and infrastructure files blocked (defaults)'}
                  {l.addBlockedPaths?.length ? <>, also <code>{l.addBlockedPaths.join(', ')}</code></> : null}
                  {l.onlyFilesIn ? <>; only files in <code>{Array.isArray(l.onlyFilesIn) ? l.onlyFilesIn.join(', ') : l.onlyFilesIn}</code></> : null}; no binary files or mode changes.
                </li>
                {l.allowRiskyPaths ? (
                  <li className="tone-bad"><strong>Allows risky paths:</strong> CI/CD or dependency files the defaults block may change.</li>
                ) : null}
                <li>
                  {s.autoPushAt === undefined ? 'Never allows a push without a person (no autoPushAt).' : `Allows a push without a person from confidence ${s.autoPushAt} (computed by Dittoly from its own checks).`}
                </li>
              </ul>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
