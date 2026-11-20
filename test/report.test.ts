import { describe, expect, it } from 'vitest';
import { formatReport } from '../src/runtime/report.js';

type Result = { passed: boolean; summary: string; counts: { total: number; passed: number; failed: number; blocked: number }; markdown: string };
const report = (items: unknown) => formatReport({ id: 'report', heading: 'Investigation results' }, items, undefined) as Result;

describe('report evidence', () => {
  it('does not treat a source-file list as successful checks', () => {
    const result = report(['src/app.js']);
    expect(result.passed).toBe(false);
    expect(result.counts).toEqual({ total: 1, passed: 0, failed: 0, blocked: 1 });
    expect(result.summary).not.toContain('All checks passed');
  });

  it('keeps an unexecuted AI checklist unverified and preserves expected behavior', () => {
    const result = report([{ check: 'Reproduce the failure', expect: 'The regression fails before the fix.' }]);
    expect(result.passed).toBe(false);
    expect(result.counts.blocked).toBe(1);
    expect(result.markdown).toContain('The regression fails before the fix.');
  });

  it.each(['skipped', 'unknown', 'not_run'])('does not turn status %s into a pass', (status) => {
    expect(report([{ check: 'Regression test', status }]).counts).toEqual({ total: 1, passed: 0, failed: 0, blocked: 1 });
  });

  it('retains explicit pass, failure, and blocked results', () => {
    expect(report([{ check: 'Build', status: 'pass' }, { check: 'Test', passed: false }, { check: 'Publish', status: 'blocked' }]).counts)
      .toEqual({ total: 3, passed: 1, failed: 1, blocked: 1 });
    expect(report([{ check: 'Build', passed: true }]).passed).toBe(true);
    expect(report([]).passed).toBe(false);
  });
});
