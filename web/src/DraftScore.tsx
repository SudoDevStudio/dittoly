import { Icon } from './ui';

/**
 * What a draft is worth, as the few rows a reviewer actually asks about. The same reading the benchmark counts and
 * the AI is asked to fix while it drafts, so the page, the comparison and the drafting round never disagree.
 */
export interface ModuleQuality {
  security: string[];
  performance: string[];
  tests: { total: number; passed: number };
  explained: boolean;
  clean: boolean;
}

export interface FlowQuality {
  writes: number;
  signOffBeforeWrite: boolean;
  conditionOnWrite: boolean;
  remembers: boolean;
  unacceptedInjection: number;
  examples: { total: number; passed: number };
  clean: boolean;
}

type Tone = 'ok' | 'warn' | 'bad' | 'info';
function Row({ tone, label, detail }: { tone: Tone; label: string; detail?: string }) {
  return (
    <li className={`score-row tone-${tone}`}>
      <Icon name={tone === 'ok' ? 'check' : tone === 'bad' ? 'alert' : 'info'} size={13} />
      <span className="score-label">{label}</span>
      {detail ? <span className="score-detail">{detail}</span> : null}
    </li>
  );
}

function Head({ clean, what }: { clean: boolean; what: string }) {
  return (
    <p className={`score-head ${clean ? 'tone-ok' : 'tone-warn'}`}>
      {clean ? `Nothing to send back: this ${what} passes every check Dittoly makes of a draft.` : `Worth reading closely before approving: not every check of a draft passed.`}
    </p>
  );
}

export function ModuleScore({ q }: { q: ModuleQuality }) {
  return (
    <div className="score">
      <Head clean={q.clean} what="module" />
      <ul className="score-rows">
        <Row
          tone={q.security.length ? 'bad' : 'ok'}
          label={q.security.length ? `${q.security.length} security finding(s)` : 'No security findings'}
          detail={q.security.join(', ')}
        />
        <Row
          tone={q.performance.length ? 'warn' : 'ok'}
          label={q.performance.length ? `${q.performance.length} performance finding(s)` : 'No performance findings'}
          detail={q.performance.join(', ')}
        />
        <Row
          tone={q.tests.total === 0 ? 'bad' : q.tests.passed < q.tests.total ? 'bad' : 'ok'}
          label={q.tests.total === 0 ? 'No sandbox tests' : `${q.tests.passed} of ${q.tests.total} sandbox test(s) pass`}
        />
        <Row tone={q.explained ? 'ok' : 'warn'} label={q.explained ? 'Every setting is explained' : 'A setting has no help or example'} />
      </ul>
    </div>
  );
}

export function FlowScore({ q }: { q: FlowQuality }) {
  return (
    <div className="score">
      <Head clean={q.clean} what="Flow" />
      <ul className="score-rows">
        <Row tone="info" label={q.writes ? `${q.writes} step(s) change something out there` : 'Changes nothing out there'} />
        <Row
          tone={q.signOffBeforeWrite ? 'ok' : 'bad'}
          label={q.signOffBeforeWrite ? 'Somebody signs off before the first change' : 'It changes something before anybody signs off'}
        />
        <Row tone={q.conditionOnWrite ? 'ok' : 'warn'} label={q.conditionOnWrite ? 'Its changes are guarded by a condition' : 'Nothing guards its changes'} />
        <Row tone={q.remembers || !q.writes ? 'ok' : 'warn'} label={q.remembers || !q.writes ? 'It remembers what it handled' : 'It does not remember what it handled: a second run would repeat it'} />
        <Row
          tone={q.unacceptedInjection ? 'bad' : 'ok'}
          label={q.unacceptedInjection ? `${q.unacceptedInjection} step(s) reachable by model-written text, waiting for a sign-off` : 'No model-written text reaches a step that changes something'}
        />
        <Row
          tone={q.examples.total === 0 ? 'warn' : q.examples.passed < q.examples.total ? 'bad' : 'ok'}
          label={q.examples.total === 0 ? 'No examples came with the draft' : `${q.examples.passed} of ${q.examples.total} example(s) passed when it was drafted`}
        />
      </ul>
    </div>
  );
}
