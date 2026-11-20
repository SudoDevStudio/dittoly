import type { Queryable } from '../db/db.js';
import type { FlowDefinition } from '../flows/definition.js';
import { DEFAULT_ANTHROPIC_MODEL } from '../runtime/ai-anthropic.js';
import { DEFAULT_OPENAI_MODEL } from '../runtime/ai-openai.js';
import { AiError, type AiProvider, type JsonRequest } from './provider.js';

/**
 * Which model a Flow's AI steps run with ("provider:model", e.g. "anthropic:claude-opus-5-5"). A Flow follows the
 * organization's model, so an admin switches every Flow at once; an approver may lock a version to one model
 * (flow_versions.model_locked), and a run may be started with a model of its own (runs.ai_model) unless its version is
 * locked. A model that is gone never stops a run: the step falls back to the organization's model and approvers are
 * told. A model change is still checked in the background (src/ai/model-changes.ts), for approvers to look at.
 */

/** What a provider uses when no model is configured, so a pin never silently follows a new default. */
const DEFAULTS: Record<string, string> = { anthropic: DEFAULT_ANTHROPIC_MODEL, openai: DEFAULT_OPENAI_MODEL };

/** The organization's model as a pin: "provider:model" ("default" when the provider picks, as the CLIs do). */
export function modelId(provider: string, configured: string | undefined): string {
  return `${provider}:${configured || DEFAULTS[provider] || 'default'}`;
}

export function splitModel(id: string): { provider: string; model: string } {
  const at = id.indexOf(':');
  return at < 0 ? { provider: id, model: 'default' } : { provider: id.slice(0, at), model: id.slice(at + 1) };
}

/** Steps that use the organization's AI: the ones a pin applies to (a runner's own key uses its own model). */
export function orgAiSteps(def: FlowDefinition) {
  return def.steps.filter((s) => (s.type === 'ai' || s.type === 'browse' || s.type === 'fix') && s.ai === 'organization');
}

/**
 * The organization's provider, asked for the pinned model on every call. A pin to another
 * provider, or a model the provider no longer knows, fails with pinned_model_unavailable.
 */
export function pinTo(provider: AiProvider, pinned: string): AiProvider {
  const { provider: wanted, model } = splitModel(pinned);
  // The organization's AI (org-model.ts) may have several providers: a pin goes to its own, asked as is.
  const routed = provider as AiProvider & { forProvider?: (id: string) => AiProvider | null };
  const target = routed.forProvider ? routed.forProvider(wanted) : wanted === provider.id ? provider : null;
  return {
    id: target?.id ?? provider.id,
    async generateJson(req: JsonRequest) {
      if (!target) throw new AiError('pinned_model_unavailable');
      try {
        return await target.generateJson(model === 'default' ? req : { ...req, model });
      } catch (err) {
        if (err instanceof AiError && err.code === 'ai_model_not_found') throw new AiError('pinned_model_unavailable');
        throw err;
      }
    },
  };
}

/** The model a run's organization AI steps ask for: the run's own, else its version's lock, else the organization's. */
export async function runModel(db: Queryable, runId: string, current: string): Promise<string> {
  const { rows } = await db.query<{ run_model: string | null; ai_model: string | null; model_locked: boolean }>(
    `SELECT r.ai_model AS run_model, v.ai_model, v.model_locked FROM runs r JOIN flow_versions v ON v.id = r.flow_version_id WHERE r.id = $1`,
    [runId],
  );
  const r = rows[0];
  return r?.run_model ?? (r?.model_locked && r.ai_model ? r.ai_model : current);
}

/**
 * Asks `chosen`; when that model is gone (pinned_model_unavailable), asks `fallback` instead from then on and says so
 * once through onFallback.
 */
export function withFallback(chosen: AiProvider, fallback: AiProvider, onFallback: () => void): AiProvider {
  let gone = false;
  return {
    get id() {
      return gone ? fallback.id : chosen.id;
    },
    async generateJson(req: JsonRequest) {
      if (!gone) {
        try {
          return await chosen.generateJson(req);
        } catch (err) {
          if (!(err instanceof AiError && err.code === 'pinned_model_unavailable')) throw err;
          gone = true;
          onFallback();
        }
      }
      return fallback.generateJson(req);
    },
  };
}

/** A model id as a person or a run gives it: "provider:model". */
export const MODEL_ID = /^[a-z][\w-]{0,39}:[\w.:\/@-]{1,200}$/;
