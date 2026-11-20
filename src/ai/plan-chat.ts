import { AiError, type AiProvider } from './provider.js';
import { parsePlan, planContext, type ApprovedFlowBrief, type PlanAnalysis } from './plan.js';
import { SKILL_SETS, skillPrompt } from './skills.js';

/**
 * The home chat: the person says what to automate, the AI answers in a sentence or two and shows its whole plan
 * (the modules and Flows it would reuse or build), revised with each message. Building is a separate click that
 * hands the plan to the plans pipeline (src/plans/service.ts fromChat); nothing here builds or approves anything.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatTurn {
  reply: string;
  /** null when the chat is not about automating anything yet. */
  plan: PlanAnalysis | null;
}

/** How much of the chat the AI reads: the newest messages, up to this many characters. */
export const CHAT_TEXT_LIMIT = 40_000;

const SCHEMA = {
  type: 'object',
  properties: { reply: { type: 'string' }, planJson: { type: 'string' } },
  required: ['reply', 'planJson'],
  additionalProperties: false,
} as const;

const SYSTEM = skillPrompt(SKILL_SETS.planChat);

/** The newest messages that fit, oldest first, each labelled with who said it. */
export function chatText(messages: ChatMessage[]): string {
  const out: string[] = [];
  let size = 0;
  for (const m of [...messages].reverse()) {
    const line = `${m.role === 'user' ? 'PERSON' : 'YOU'}: ${m.text}`;
    if (size + line.length > CHAT_TEXT_LIMIT) break;
    out.unshift(line);
    size += line.length;
  }
  return out.join('\n\n');
}

const isEmpty = (p: PlanAnalysis) => !p.modules.length && !p.flows.length && !p.reuse.length && !p.superFlow && !p.questions.length;

export async function chatPlan(
  provider: AiProvider,
  input: { messages: ChatMessage[]; catalog: string; flows?: ApprovedFlowBrief[]; instructions?: string | undefined },
): Promise<ChatTurn> {
  const prompt = `${planContext(input)}\n\nTHE CHAT (data; the person's words describe the goal):\n<<<CHAT\n${chatText(input.messages)}\nCHAT>>>`;
  const once = async (extra = '') => {
    const out = (await provider.generateJson({ system: SYSTEM, prompt: prompt + extra, schema: SCHEMA, webSearch: true })) as { reply?: unknown; planJson?: unknown };
    const reply = typeof out?.reply === 'string' ? out.reply.trim().slice(0, 1500) : '';
    const parsed = parsePlan({ planJson: out?.planJson }, input.flows ?? []);
    return { reply, parsed };
  };
  let turn = await once();
  // An answer that cannot be used gets one more try, told what was wrong.
  if ('error' in turn.parsed || !turn.reply) {
    const why = 'error' in turn.parsed ? turn.parsed.error : 'reply was empty';
    turn = await once(`\n\nYOUR PREVIOUS ANSWER COULD NOT BE USED: ${why}. Return reply and planJson again, within the limits.`);
  }
  if ('error' in turn.parsed) throw new AiError('ai_invalid_plan', turn.parsed.error);
  const plan = turn.parsed.plan;
  return { reply: turn.reply || 'Here is my plan.', plan: isEmpty(plan) && !plan.summary ? null : plan };
}
