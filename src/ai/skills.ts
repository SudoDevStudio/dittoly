import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SKILLS_DIR } from '../paths.js';

/**
 * The skill files in skills/<name>/SKILL.md are the AI's standing rules for drafting modules, Flows,
 * Super Flows and plans, for every provider. They ship with Dittoly and are not editable per
 * organization; admins add their own rules with the organization AI instructions, which come after.
 */

export interface Skill {
  name: string;
  description: string;
  body: string;
}

/** Which skills make up each drafting prompt, in order. */
export const SKILL_SETS = {
  module: ['dittoly-basics', 'dittoly-factory', 'module-authoring', 'module-protocols', 'browser-scripts', 'secure-modules', 'performant-modules'],
  flow: ['dittoly-basics', 'dittoly-factory', 'flow-authoring', 'flow-ai-steps', 'super-flow-authoring'],
  plan: ['dittoly-basics', 'dittoly-factory', 'plan-breakdown'],
  /** The home chat: the plan rules, then how to plan in a conversation (show the plan first, ask only what blocks). */
  planChat: ['dittoly-basics', 'dittoly-factory', 'plan-breakdown', 'plan-chat'],
  /** Given to AI assistants over MCP: saving work they did as a Flow; module rules only when they need a new module. */
  capture: ['dittoly-basics', 'dittoly-factory', 'save-ai-work', 'flow-authoring', 'flow-ai-steps', 'super-flow-authoring'],
} as const;

export function readSkill(name: string, dir = SKILLS_DIR): Skill {
  const file = path.join(dir, name, 'SKILL.md');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`missing AI skill file ${file}: Dittoly's skills/ directory must ship with it`);
  }
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error(`${file} has no front matter (name, description)`);
  const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(m[1]!)?.[1]?.trim() ?? '';
  const skill = { name: field('name'), description: field('description'), body: text.slice(m[0].length).trim() };
  if (skill.name !== name || !skill.description) throw new Error(`${file} must name itself "${name}" and have a description`);
  return skill;
}

/** One system prompt from several skills, in the given order. */
export function skillPrompt(names: readonly string[], dir = SKILLS_DIR): string {
  return names.map((n) => readSkill(n, dir).body).join('\n\n');
}
