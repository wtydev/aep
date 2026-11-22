import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { InProcessLauncher, ProcessLauncher, formatHuman, runSuite } from '@wty.dev/aep-testing';
import type { SuiteReport } from '@wty.dev/aep-testing';

const root = fileURLToPath(new URL('../../', import.meta.url));
const HOST = fileURLToPath(new URL('../../examples/minimal-host/dist/main.js', import.meta.url));
const DEMO = fileURLToPath(new URL('../../examples/minimal-client/dist/main.js', import.meta.url));
const TIMEOUT = 180_000;

function requireBuilt(file: string): void {
  if (!existsSync(file)) {
    throw new Error(`${file} does not exist: run "pnpm build" before the conformance tests`);
  }
}

function expectClean(report: SuiteReport): void {
  const failures = report.results.filter((r) => r.status === 'failed');
  expect(
    failures.map((f) => `${f.level}/${f.id}: ${f.reason}`),
    formatHuman(report),
  ).toEqual([]);
  expect(report.totals.failed).toBe(0);
  expect(report.totals.passed).toBeGreaterThanOrEqual(170);
  expect(report.levelsAchieved).toEqual(report.levels.map((l) => l.level));
  // The reference host is durable, so the durability level runs (restart tests are not skipped).
  expect(report.durability).toBe('durable');
  expect(report.restartSupported).toBe(true);
  expect(report.levelsAchieved).toContain('durability');
  const durability = report.levels.find((l) => l.level === 'durability');
  expect(durability?.passed).toBeGreaterThanOrEqual(6);
  expect(durability?.skipped).toBe(0);
}

describe('reference host conformance', () => {
  it(
    'passes the whole suite in-process',
    async () => {
      expectClean(await runSuite({ launcher: new InProcessLauncher() }));
    },
    TIMEOUT,
  );

  it(
    'passes the whole suite as a separate process',
    async () => {
      requireBuilt(HOST);
      const report = await runSuite({
        launcher: new ProcessLauncher('node', [HOST]),
        timeoutMs: 60_000,
      });
      expectClean(report);
    },
    TIMEOUT,
  );
});

describe('demo client end to end', () => {
  for (const transport of ['stdio', 'directory']) {
    it(
      `completes the scripted tour over ${transport}`,
      async () => {
        requireBuilt(HOST);
        requireBuilt(DEMO);
        const { code, output } = await new Promise<{ code: number | null; output: string }>(
          (resolve, reject) => {
            const child = spawn('node', [DEMO, '--transport', transport], {
              cwd: root,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let output = '';
            child.stdout.on('data', (d: Buffer) => (output += d.toString('utf8')));
            child.stderr.on('data', (d: Buffer) => (output += d.toString('utf8')));
            child.once('error', reject);
            child.once('close', (code) => resolve({ code, output }));
          },
        );
        expect(code, output).toBe(0);
        expect(output).toContain('demo complete');
      },
      TIMEOUT,
    );
  }
});
