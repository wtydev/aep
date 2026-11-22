/** Human-readable and JSON renderings of a {@link SuiteReport}. */
import { LEVELS } from './suite.js';
import type { SuiteReport, TestResult } from './runner.js';

const MARK = { passed: '✓', failed: '✗', skipped: '-' } as const;

function line(r: TestResult): string[] {
  const head = `  ${MARK[r.status]} ${r.id}  ${r.title}`;
  if (r.status === 'passed') return [head];
  const label = r.status === 'skipped' ? 'skip' : 'FAIL';
  const reason = (r.reason ?? '').split('\n').map((l) => `      ${l}`);
  return [`${head}  [${label}]`, ...reason];
}

export function formatHuman(report: SuiteReport): string {
  const out: string[] = [`AEP conformance — ${report.launcher}`, ''];
  for (const level of LEVELS) {
    const rows = report.results.filter((r) => r.level === level);
    if (rows.length === 0) continue;
    out.push(`${level}`);
    for (const r of rows) out.push(...line(r));
    out.push('');
  }
  out.push('Summary');
  for (const l of report.levels) {
    out.push(
      `  ${l.level.padEnd(10)} ${l.passed} passed, ${l.failed} failed, ${l.skipped} skipped` +
        `  ${l.achieved ? 'ACHIEVED' : l.failed > 0 ? 'not achieved' : 'n/a (nothing ran)'}`,
    );
  }
  const t = report.totals;
  out.push(
    '',
    `Total: ${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped (${t.total} tests, ` +
      `${(report.durationMs / 1000).toFixed(1)} s)`,
    `Levels achieved: ${report.levelsAchieved.length > 0 ? report.levelsAchieved.join(', ') : 'none'}`,
  );
  return out.join('\n');
}

export function formatJson(report: SuiteReport): string {
  return JSON.stringify(report, null, 2);
}
