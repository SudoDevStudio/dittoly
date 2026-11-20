import { useState } from 'react';
import { api, post } from './api';
import { useAction } from './components';

/** A step as a Flow definition holds it: enough to tell which later steps read its result. */
interface DefStep {
  id: string;
  title?: string;
  [k: string]: unknown;
}

/** The titles of the steps that read `id`'s result ({{ steps.<id>.… }}). */
export function stepsUsing(steps: DefStep[], id: string): string[] {
  const ref = new RegExp(`steps\\.${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
  return steps.filter((x) => x.id !== id && ref.test(JSON.stringify(x))).map((x) => x.title ?? x.id);
}

/**
 * Removing one step from a Flow in one click: a new version of the Flow without it, made from its newest version (the
 * approved one keeps running until the new one is approved). A step whose result later steps use is removed by the
 * AI, which changes those steps so the Flow still works.
 */
export function useRemoveStep(flowId: string, onSaved: () => void) {
  const act = useAction();
  const [busyId, setBusyId] = useState<string | null>(null);
  const remove = (stepId: string, title?: string | null, usedBy: string[] = []) => {
    const name = title ?? stepId;
    // Asked first: one click on a graph node is easy to make by mistake.
    const question = usedBy.length
      ? `Remove "${name}" from the Flow?\n\nLater steps use its result (${usedBy.join(', ')}), so the AI removes it and changes them. This makes a new version of the Flow to approve; the approved one keeps running until then.`
      : `Remove "${name}" from the Flow?\n\nThis makes a new version of the Flow without it, to approve; the approved one keeps running until then.`;
    if (!confirm(question)) return;
    setBusyId(stepId);
    void act
      .run(async () => {
        const versions = await api<{ definition: { steps: DefStep[] } & Record<string, unknown> }[]>(`/flows/${flowId}/versions`);
        const current = versions.at(-1)!.definition;
        if (!current.steps.some((x) => x.id === stepId)) throw new Error(`"${name}" is no longer in the newest version of this Flow.`);
        if (current.steps.length < 2) throw new Error('A Flow needs at least one step: delete the Flow instead.');
        const users = stepsUsing(current.steps, stepId);
        if (users.length) {
          await post(`/flows/${flowId}/revise`, {
            feedback: `Remove the step "${name}" (id ${stepId}). These steps use its result: ${users.join(', ')}. Change them so the Flow still works without it; keep every other step as it is.`,
          });
        } else {
          await api(`/flows/${flowId}`, { method: 'PUT', body: { definition: { ...current, steps: current.steps.filter((x) => x.id !== stepId) } } });
        }
        onSaved();
      }, `"${name}" removed: a new version of the Flow to approve`)
      .finally(() => setBusyId(null));
  };
  return { remove, busyId, busy: act.busy, error: act.error };
}
