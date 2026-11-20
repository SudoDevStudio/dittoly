import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FLOW_SYSTEM_PROMPT } from '../src/ai/generate-flow.js';
import { MODULE_SYSTEM_PROMPT } from '../src/ai/generate-module.js';
import { CLASSIFY_RULES, MAX_QUESTIONS } from '../src/ai/classify.js';
import { readSkill, SKILL_SETS, skillPrompt } from '../src/ai/skills.js';
import { stepSchema, WIDGETS } from '../src/flows/definition.js';
import { endpointSchema } from '../src/modules/manifest.js';
import { SKILLS_DIR } from '../src/paths.js';

describe('AI skill files', () => {
  it('every skill names itself, has a description, and is used by a drafting prompt', () => {
    const used = new Set<string>(Object.values(SKILL_SETS).flat());
    const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(dirs.sort()).toEqual([...used].sort());
    for (const name of used) {
      const s = readSkill(name);
      expect(s.description.length).toBeGreaterThan(20);
      expect(s.body).not.toMatch(/^---/);
    }
  });

  it('the drafting prompts are made of the skills, basics first', () => {
    expect(MODULE_SYSTEM_PROMPT).toBe(skillPrompt(SKILL_SETS.module));
    expect(FLOW_SYSTEM_PROMPT).toBe(skillPrompt(SKILL_SETS.flow));
    for (const set of Object.values(SKILL_SETS)) expect(set[0]).toBe('dittoly-basics');
    expect(MODULE_SYSTEM_PROMPT).toContain('You must not:');
  });

  it('a missing skill file is a clear error', () => {
    expect(() => readSkill('no-such-skill')).toThrow(/missing AI skill file/);
  });

  // The skills must keep up with the code: a new step type, widget or protocol needs words in them.
  it('the Flow skills describe every step type and widget the validator accepts', () => {
    for (const option of stepSchema.options) {
      const type = option.shape.type.value;
      expect(FLOW_SYSTEM_PROMPT, `step type ${type}`).toContain(`"type": "${type}"`);
    }
    for (const w of WIDGETS) expect(FLOW_SYSTEM_PROMPT, `widget ${w}`).toContain(`"${w}"`);
  });

  it('the module skills describe every endpoint protocol and every forbidden call', () => {
    for (const option of endpointSchema.options) {
      const protocol = option.shape.protocol.value;
      expect(MODULE_SYSTEM_PROMPT, `protocol ${protocol}`).toContain(`"protocol": "${protocol}"`);
    }
    for (const word of ['import', 'require', 'eval', 'new Function', 'process', 'globalThis', 'fetch']) expect(MODULE_SYSTEM_PROMPT).toContain(word);
  });
});

/** The architecture every drafting prompt must carry: stateless modules, the Flow holding state, any model. */
describe('what the skills must say', () => {
  it('asks everything at once, before anything is built, and never more than ten', () => {
    // Being asked again after you thought you were done is the worst part of a planner; the rule lives in the
    // skills the planners read, and in the one limit the code keeps.
    for (const name of ['plan-chat', 'plan-breakdown']) {
      const body = readSkill(name).body;
      expect(body, `${name}: asks once`).toMatch(/ASK EVERYTHING AT ONCE/);
      // The rule may wrap across lines in the file.
      expect(body.replace(/\s+/g, ' '), `${name}: nothing asked later`).toMatch(/Never come back later|asked later that could have been asked here/i);
      const flat = body.replace(/\s+/g, ' ');
      expect(flat, `${name}: ten at most`).toMatch(/At most 10 questions/i);
      expect(flat, `${name}: ten is a ceiling`).toMatch(/ceiling, not a target/);
    }
    expect(MAX_QUESTIONS).toBe(10);
    // The classifier, which asks before a module or a Flow is drafted, says the same.
    expect(CLASSIFY_RULES).toMatch(/ASK EVERYTHING AT ONCE/);
    expect(CLASSIFY_RULES.replace(/\s+/g, ' ')).toMatch(/At most 10 questions/i);
  });

  it('modules keep no state and a Flow runs on any model', () => {
    for (const [name, prompt] of [['module', MODULE_SYSTEM_PROMPT], ['flow', FLOW_SYSTEM_PROMPT]] as const) {
      expect(prompt, `${name}: stateless modules`).toMatch(/keeps NO state|is STATELESS/);
      expect(prompt, `${name}: any model`).toContain('Any Flow runs on any model');
      expect(prompt, `${name}: never name a model`).toMatch(/never name a model/i);
    }
    // No prompt names a model or a provider's model family as the one to write for.
    for (const prompt of Object.values(SKILL_SETS).map((s) => skillPrompt(s))) {
      expect(prompt).not.toMatch(/\b(claude-[\w.-]+|gpt-[\w.-]+|gemini-[\w.-]+|llama-[\w.-]+)\b/i);
    }
  });
});
