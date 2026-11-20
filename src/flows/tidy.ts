/**
 * Mechanical fixes to an AI-drafted Flow definition before it is checked, in the spirit of
 * src/modules/manifest-tidy.ts: the slip models make most often, with one obvious correction, so a draft is not
 * refused (or sent back to the AI) over a missing name.
 *
 * Only names are filled in, and only names nothing can be referring to yet. Nothing here adds a step, changes what
 * a step does, or widens what the Flow may reach; the approver sees the result like any other draft.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** The ids the definition allows: a letter, then letters, digits and underscores. */
const ID = /^[a-z][a-z0-9_]{0,39}$/;

/** "Create a draft PR" / "github-fix@1.2.0" -> "create_a_draft_pr" / "github_fix", bounded as an id must be. */
function idFrom(text: string, fallback: string): string {
  const base = text
    .toLowerCase()
    .replace(/@.*$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^[^a-z]+/, '')
    .slice(0, 40);
  return ID.test(base) ? base : fallback;
}

/** `name`, or `name_2`, `name_3`… until it is one no other step has. */
function unique(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  for (let n = 2; ; n++) {
    const tried = `${name.slice(0, 37)}_${n}`;
    if (!taken.has(tried)) {
      taken.add(tried);
      return tried;
    }
  }
}

/**
 * The definition with every step named. A step whose id is missing, blank or not an id is named after what it does
 * (its action, or its type), and a repeated id gets a number. A step that already has a good id keeps it, because
 * other steps and the run form refer to it by that name.
 */
export function tidyDefinition(value: unknown): unknown {
  if (!isObj(value) || !Array.isArray(value.steps)) return value;
  const taken = new Set<string>();
  for (const step of value.steps) if (isObj(step) && typeof step.id === 'string' && ID.test(step.id)) taken.add(step.id);
  const steps = value.steps.map((step, i) => {
    if (!isObj(step)) return step;
    const out: Obj = { ...step };
    if (typeof out.id !== 'string' || !ID.test(out.id)) {
      const from = typeof out.action === 'string' ? out.action : typeof out.type === 'string' ? out.type : 'step';
      out.id = unique(idFrom(from, 'step'), taken);
    }
    // A Super Flow's step runs child Flows, each named the same way: steps.<step>.output.<id>…
    if (Array.isArray(out.runs)) {
      const inner = new Set<string>();
      for (const r of out.runs) if (isObj(r) && typeof r.id === 'string' && ID.test(r.id)) inner.add(r.id);
      out.runs = out.runs.map((r, j) => (isObj(r) && (typeof r.id !== 'string' || !ID.test(r.id)) ? { ...r, id: unique(`flow_${j + 1}`, inner) } : r));
    }
    return out;
  });
  return { ...value, steps };
}
