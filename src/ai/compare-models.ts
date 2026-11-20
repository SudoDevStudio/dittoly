import { draftedByLabel, type DraftCost, type DraftedBy } from '../modules/registry.js';
import { draftQuality } from '../modules/validate.js';
import type { ValidationReport } from '../modules/validate.js';
import type { Queryable } from '../db/db.js';

/**
 * Which AI writes the better work here — on this organization's own drafts, not on a benchmark somewhere else.
 * Every version an AI wrote records the model that answered it ("anthropic:claude-opus-5:medium"), what the
 * checks found, and what the draft cost; this adds those up per model, so a choice of model can be made from
 * what it actually produced rather than from a vendor's page.
 */
export interface ModelRow {
  /** "provider:model:effort" — the exact model, because opus-5 and opus-5.5 write differently. */
  label: string;
  provider: string;
  model: string;
  effort: string | null;
  modules: {
    drafted: number;
    approved: number;
    rejected: number;
    /** Security and performance findings over all its modules, and how many of them had none. */
    security: number;
    performance: number;
    clean: number;
    /** Modules whose sandbox tests all passed, and modules it wrote no test for at all. */
    testsPass: number;
    noTests: number;
  };
  flows: {
    drafted: number;
    approved: number;
    rejected: number;
    /** Examples it wrote with its Flows, and how many passed when the draft was stored. */
    examples: number;
    examplesPassed: number;
  };
  /** What its drafts cost, where it was recorded: tokens, and AI calls (a call over one is a round of fixing). */
  cost: { drafts: number; input: number; output: number; calls: number };
}

const empty = (by: DraftedBy, label: string): ModelRow => ({
  label,
  provider: by.provider,
  model: by.model || 'unknown',
  effort: by.effort ?? null,
  modules: { drafted: 0, approved: 0, rejected: 0, security: 0, performance: 0, clean: 0, testsPass: 0, noTests: 0 },
  flows: { drafted: 0, approved: 0, rejected: 0, examples: 0, examplesPassed: 0 },
  cost: { drafts: 0, input: 0, output: 0, calls: 0 },
});

export async function compareModels(db: Queryable): Promise<{ rows: ModelRow[]; drafts: number }> {
  const rows = new Map<string, ModelRow>();
  const row = (by: DraftedBy | null) => {
    const label = draftedByLabel(by);
    if (!label || !by) return null;
    let r = rows.get(label);
    if (!r) rows.set(label, (r = empty(by, label)));
    return r;
  };
  const spend = (r: ModelRow, cost: DraftCost | null) => {
    if (!cost) return;
    r.cost.drafts += 1;
    r.cost.input += cost.input;
    r.cost.output += cost.output;
    r.cost.calls += cost.calls;
  };

  const modules = await db.query<{ by: DraftedBy | null; cost: DraftCost | null; status: string; report: ValidationReport | null }>(
    `SELECT generation->'by' AS by, generation->'cost' AS cost, status, validation_report AS report
     FROM module_versions WHERE generation->'by' IS NOT NULL ORDER BY created_at`,
  );
  for (const m of modules.rows) {
    const r = row(m.by);
    if (!r) continue;
    r.modules.drafted += 1;
    if (m.status === 'approved') r.modules.approved += 1;
    if (m.status === 'rejected') r.modules.rejected += 1;
    const q = draftQuality(m.report);
    if (q) {
      r.modules.security += q.security.length;
      r.modules.performance += q.performance.length;
      if (q.clean) r.modules.clean += 1;
      if (!q.tests.total) r.modules.noTests += 1;
      else if (q.tests.passed === q.tests.total) r.modules.testsPass += 1;
    }
    spend(r, m.cost);
  }

  const flows = await db.query<{ by: DraftedBy | null; cost: DraftCost | null; status: string; examples: { total: number; passed: number } | null }>(
    `SELECT generation->'by' AS by, generation->'cost' AS cost, status, generation->'examples' AS examples
     FROM flow_versions WHERE generation->'by' IS NOT NULL ORDER BY created_at`,
  );
  for (const f of flows.rows) {
    const r = row(f.by);
    if (!r) continue;
    r.flows.drafted += 1;
    if (f.status === 'approved') r.flows.approved += 1;
    if (f.status === 'rejected') r.flows.rejected += 1;
    if (f.examples) {
      r.flows.examples += f.examples.total;
      r.flows.examplesPassed += f.examples.passed;
    }
    spend(r, f.cost);
  }

  // The model with the most work first: that is the one a change of model would affect.
  const out = [...rows.values()].sort((a, b) => b.modules.drafted + b.flows.drafted - (a.modules.drafted + a.flows.drafted) || a.label.localeCompare(b.label));
  return { rows: out, drafts: out.reduce((n, r) => n + r.modules.drafted + r.flows.drafted, 0) };
}
