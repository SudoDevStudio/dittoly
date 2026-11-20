import type { ReportStep } from './types.js';

/** Report steps: a list of checks as Markdown, Slack, Jira and plain text. */

const ICON = { pass: '✅', fail: '❌', blocked: '⚠️' } as const;
const WORD = { pass: 'passed', fail: 'failed', blocked: 'could not be checked' } as const;

export function formatReport(step: ReportStep, items: unknown, link: string | undefined): unknown {
  const list = (Array.isArray(items) ? items : []).slice(0, 50).map((v) => {
    const o = (v && typeof v === 'object' ? v : { check: String(v) }) as Record<string, unknown>;
    const s = String(o.status ?? (o.passed === true ? 'pass' : o.passed === false ? 'fail' : 'blocked')).toLowerCase();
    // A checklist, filename, skipped item, or unknown status is not evidence of a successful check.
    const status: keyof typeof ICON = s === 'fail' || s === 'failed' ? 'fail' : s === 'pass' || s === 'passed' ? 'pass' : 'blocked';
    const label = String(o.check ?? o.title ?? o.name ?? o.label ?? '').slice(0, 300) || 'Item';
    const note = String(o.note ?? o.result ?? (o.expect ? (status === 'blocked' ? `Not checked. Expected: ${String(o.expect)}` : String(o.expect)) : status === 'blocked' ? 'No verified result recorded.' : '')).slice(0, 500);
    return { label, status, note, screenshot: typeof o.screenshot === 'string' && o.screenshot.startsWith('data:image/') ? o.screenshot : null };
  });
  const passed = list.filter((i) => i.status === 'pass').length;
  const verdict = list.length && passed === list.length ? 'All checks passed' : `${passed} of ${list.length} checks passed`;
  const tail = link ? `\n\n${link}` : '';
  const markdown =
    `### ${step.heading}\n\n` +
    list.map((i) => `- [${i.status === 'pass' ? 'x' : ' '}] **${i.label}**: ${i.note ? `${i.note} ` : ''}${i.status === 'pass' ? '' : `(${WORD[i.status]})`}`.trimEnd()).join('\n') +
    `\n\n**${verdict}.**${tail}`;
  const slack = `*${step.heading}*\n` + list.map((i) => `${ICON[i.status]} *${i.label}*${i.note ? ` — ${i.note}` : ''}`).join('\n') + `\n*${verdict}.*${tail}`;
  // Jira text formatting (wiki markup), for comments through Jira's API v2.
  const jiraIcon = { pass: '(/)', fail: '(x)', blocked: '(!)' } as const;
  const jira = `h3. ${step.heading}\n\n` + list.map((i) => `${jiraIcon[i.status]} *${i.label}*${i.note ? ` — ${i.note}` : ''}`).join('\n') + `\n\n*${verdict}.*${tail}`;
  const plain = `${step.heading}\n` + list.map((i) => `[${i.status.toUpperCase()}] ${i.label}${i.note ? ` — ${i.note}` : ''}`).join('\n') + `\n${verdict}.${tail}`;
  return {
    passed: list.length > 0 && passed === list.length,
    summary: `${verdict}.`,
    counts: { total: list.length, passed, failed: list.filter((i) => i.status === 'fail').length, blocked: list.filter((i) => i.status === 'blocked').length },
    markdown,
    slack,
    jira,
    plain,
    screenshots: list.flatMap((i) => (i.screenshot ? [i.screenshot] : [])),
  };
}
