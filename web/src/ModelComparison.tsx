import { api } from './api';
import { Card, Empty, ErrorText, Loading, Page, useLoad } from './components';
import { Icon } from './ui';

interface Row {
  label: string;
  provider: string;
  model: string;
  effort: string | null;
  modules: { drafted: number; approved: number; rejected: number; security: number; performance: number; clean: number; testsPass: number; noTests: number };
  flows: { drafted: number; approved: number; rejected: number; examples: number; examplesPassed: number };
  cost: { drafts: number; input: number; output: number; calls: number };
}

const per = (n: number, of: number) => (of ? (n / of).toFixed(of > 1 ? 1 : 0) : '—');
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '—');
const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString());

/**
 * Which AI to draft with, decided on this organization's own work: every version an AI wrote records the model
 * that answered it, what the checks found and what it cost, and those are added up here.
 */
export function ModelComparisonPage() {
  const list = useLoad(() => api<{ rows: Row[]; drafts: number }>('/admin/model-comparison'));
  return (
    <Page
      title="Which AI writes the better work"
      eyebrow="OVERSIGHT / MODELS"
      description="Counted from the drafts made here, per exact model. A model's name alone says little: the same family at a different release, or told to think less, writes differently."
    >
      {list.error ? (
        <ErrorText>{list.error}</ErrorText>
      ) : !list.data ? (
        <Loading />
      ) : !list.data.rows.length ? (
        <Empty>Nothing to compare yet. Every module and Flow an AI drafts from now on records the model that wrote it.</Empty>
      ) : (
        <>
          <Card title="Modules">
            <div className="table-wrap">
              <table className="model-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Drafted</th>
                    <th>Approved</th>
                    <th>Nothing to send back</th>
                    <th>Security findings each</th>
                    <th>Performance findings each</th>
                    <th>Tests all pass</th>
                    <th>No tests at all</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.rows
                    .filter((r) => r.modules.drafted)
                    .map((r) => (
                      <tr key={r.label}>
                        <th scope="row"><code>{r.label}</code></th>
                        <td>{r.modules.drafted}</td>
                        <td>{pct(r.modules.approved, r.modules.drafted)}</td>
                        <td>{pct(r.modules.clean, r.modules.drafted)}</td>
                        <td>{per(r.modules.security, r.modules.drafted)}</td>
                        <td>{per(r.modules.performance, r.modules.drafted)}</td>
                        <td>{pct(r.modules.testsPass, r.modules.drafted)}</td>
                        <td>{r.modules.noTests}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <p className="muted">
              A finding is what Dittoly's own review found and asked the AI to fix while it drafted: weak randomness, a
              call per item in a loop, pagination with no cap, a write action with no test for bad input.
            </p>
          </Card>

          <Card title="Flows">
            <div className="table-wrap">
              <table className="model-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Drafted</th>
                    <th>Approved</th>
                    <th>Examples written</th>
                    <th>Examples that passed</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.rows
                    .filter((r) => r.flows.drafted)
                    .map((r) => (
                      <tr key={r.label}>
                        <th scope="row"><code>{r.label}</code></th>
                        <td>{r.flows.drafted}</td>
                        <td>{pct(r.flows.approved, r.flows.drafted)}</td>
                        <td>{per(r.flows.examples, r.flows.drafted)}</td>
                        <td>{pct(r.flows.examplesPassed, r.flows.examples)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="What it cost">
            <div className="table-wrap">
              <table className="model-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Drafts counted</th>
                    <th>Tokens in each</th>
                    <th>Tokens out each</th>
                    <th>AI calls each</th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.rows
                    .filter((r) => r.cost.drafts)
                    .map((r) => (
                      <tr key={r.label}>
                        <th scope="row"><code>{r.label}</code></th>
                        <td>{r.cost.drafts}</td>
                        <td>{k(Math.round(r.cost.input / r.cost.drafts))}</td>
                        <td>{k(Math.round(r.cost.output / r.cost.drafts))}</td>
                        <td>{(r.cost.calls / r.cost.drafts).toFixed(1)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            <p className="muted">
              <Icon name="info" size={13} /> More than one call per draft means it was sent back to be fixed: the
              cheaper model that needs three rounds is not the cheaper one.
            </p>
          </Card>
        </>
      )}
    </Page>
  );
}
