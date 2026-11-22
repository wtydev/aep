/** Runs a set of conformance tests against a {@link HostLauncher}. */
import { CONFORMANCE_FIXTURE } from './fixture.js';
import { ConformanceFailure, SkipTest, TestContext } from './context.js';
import { LEVELS, UnsupportedLaunch } from './suite.js';
import type { ConformanceTest, HostLauncher, Level, LaunchedHost } from './suite.js';
import { ALL_TESTS } from './tests/index.js';

export type TestStatus = 'passed' | 'failed' | 'skipped';

export interface TestResult {
  id: string;
  title: string;
  level: Level;
  status: TestStatus;
  /** Failure message or skip reason. */
  reason?: string;
  durationMs: number;
}

export interface LevelSummary {
  level: Level;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  /** No failures and at least one pass. */
  achieved: boolean;
}

export interface SuiteReport {
  launcher: string;
  startedAt: string;
  durationMs: number;
  results: TestResult[];
  levels: LevelSummary[];
  /** Levels with no failures and at least one passing test. */
  levelsAchieved: Level[];
  totals: { passed: number; failed: number; skipped: number; total: number };
  /** Capability ids the host declared (empty if the host could not be probed). */
  capabilities: string[];
}

export interface RunOptions {
  launcher: HostLauncher;
  /** Defaults to the full suite. */
  tests?: ConformanceTest[];
  /** Restrict to these levels. */
  levels?: Level[];
  /** Only tests whose id contains this substring. */
  filter?: string;
  /** Tests run this many at a time (each has its own host). Default 4. */
  concurrency?: number;
  /** Per-test timeout in ms. Default 60 000. */
  timeoutMs?: number;
  /** Called after each test finishes. */
  onResult?: (result: TestResult) => void;
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    return e instanceof ConformanceFailure ? e.message : `${e.name}: ${e.message}`;
  }
  return String(e);
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ConformanceFailure(`${what} timed out after ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Capability ids declared by the host (probed once with an admin session). */
async function probeCapabilities(launcher: HostLauncher): Promise<Set<string>> {
  const host = await launcher.launch({ sessions: [{ role: 'admin' }] });
  try {
    const client = host.clients[0];
    if (!client) throw new Error('launcher returned no client');
    const r = await client.request('aep.capabilities', {});
    if (r.status !== 'succeeded') {
      throw new Error(`aep.capabilities failed: ${JSON.stringify(r.error)}`);
    }
    const output = r.output as { capabilities: Record<string, unknown> };
    return new Set(Object.keys(output.capabilities));
  } finally {
    await host.close().catch(() => {});
  }
}

async function runOne(
  test: ConformanceTest,
  launcher: HostLauncher,
  capabilities: ReadonlySet<string>,
  timeoutMs: number,
): Promise<TestResult> {
  const started = Date.now();
  const done = (status: TestStatus, reason?: string): TestResult => ({
    id: test.id,
    title: test.title,
    level: test.level,
    status,
    ...(reason !== undefined ? { reason } : {}),
    durationMs: Date.now() - started,
  });

  const missing = (test.requires ?? []).filter((c) => !capabilities.has(c));
  if (missing.length > 0) return done('skipped', `host does not declare ${missing.join(', ')}`);

  let launched: LaunchedHost | undefined;
  try {
    try {
      launched = await withTimeout(
        launcher.launch({
          fixture: CONFORMANCE_FIXTURE,
          sessions: test.sessions ?? [{ role: 'edit' }],
        }),
        timeoutMs,
        'host launch',
      );
    } catch (e) {
      if (e instanceof UnsupportedLaunch) return done('skipped', e.message);
      return done('failed', `could not launch a host: ${describe(e)}`);
    }
    const ctx = new TestContext({ launched, fixture: CONFORMANCE_FIXTURE, capabilities });
    await withTimeout(test.run(ctx), timeoutMs, 'test');
    return done('passed');
  } catch (e) {
    if (e instanceof SkipTest) return done('skipped', e.message);
    return done('failed', describe(e));
  } finally {
    if (launched) await launched.close().catch(() => {});
  }
}

export function summarize(results: TestResult[]): {
  levels: LevelSummary[];
  levelsAchieved: Level[];
  totals: SuiteReport['totals'];
} {
  const levels: LevelSummary[] = LEVELS.map((level) => {
    const own = results.filter((r) => r.level === level);
    const passed = own.filter((r) => r.status === 'passed').length;
    const failed = own.filter((r) => r.status === 'failed').length;
    return {
      level,
      passed,
      failed,
      skipped: own.length - passed - failed,
      total: own.length,
      achieved: failed === 0 && passed > 0,
    };
  }).filter((l) => l.total > 0);
  return {
    levels,
    levelsAchieved: levels.filter((l) => l.achieved).map((l) => l.level),
    totals: {
      passed: results.filter((r) => r.status === 'passed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      total: results.length,
    },
  };
}

export async function runSuite(opts: RunOptions): Promise<SuiteReport> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const tests = (opts.tests ?? ALL_TESTS).filter(
    (t) =>
      (!opts.levels || opts.levels.includes(t.level)) &&
      (!opts.filter || t.id.includes(opts.filter)),
  );

  const capabilities = await withTimeout(
    probeCapabilities(opts.launcher),
    timeoutMs,
    'capability probe',
  );

  const results: TestResult[] = new Array<TestResult>(tests.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      const test = tests[i];
      if (!test) return;
      const result = await runOne(test, opts.launcher, capabilities, timeoutMs);
      results[i] = result;
      opts.onResult?.(result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));

  return {
    launcher: opts.launcher.name,
    startedAt,
    durationMs: Date.now() - started,
    results,
    ...summarize(results),
    capabilities: [...capabilities].sort(),
  };
}
