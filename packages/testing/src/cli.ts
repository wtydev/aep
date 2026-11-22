#!/usr/bin/env node
/**
 * aep-conformance [--json] [--level a,b] [--filter text] [--concurrency n] [--timeout ms]
 *                 [--no-restart] [--list] [--help] [-- <host command...>]
 */
import { parseArgs } from 'node:util';
import { InProcessLauncher, ProcessLauncher } from './launchers.js';
import { formatHuman, formatJson } from './report.js';
import { runSuite } from './runner.js';
import type { TestResult } from './runner.js';
import { LEVELS } from './suite.js';
import type { Level } from './suite.js';
import { ALL_TESTS } from './tests/index.js';

const USAGE = `Usage: aep-conformance [options] [-- <host command...>]

Runs the AEP conformance suite. Without a host command the reference engine runs in-process.
Everything after "--" is the host command; the suite appends the launcher flags
(--transport, --fixture, --session-config, --import-root, --executors) itself, plus
--data-dir <dir> for the durability level.

Options:
  --json               machine-readable report on stdout
  --level <a,b>        only these levels (${LEVELS.join(', ')})
  --filter <text>      only tests whose id contains <text>
  --concurrency <n>    tests in parallel, each with its own host (default 4)
  --timeout <ms>       per-test timeout (default 60000)
  --no-multi-session   skip tests that need more than one session (single-session hosts)
  --no-restart         never pass --data-dir or restart the host: skips the durability level
                       (otherwise it runs when the host starts with --data-dir and reports
                       host.durability: durable)
  --list               list the tests and exit
  --help               this text

Exit code: 0 all executed tests passed, 1 any failure, 2 usage error.`;

async function main(): Promise<number> {
  const dd = process.argv.indexOf('--');
  const own = dd < 0 ? process.argv.slice(2) : process.argv.slice(2, dd);
  const hostCmd = dd < 0 ? [] : process.argv.slice(dd + 1);

  let values;
  try {
    ({ values } = parseArgs({
      args: own,
      options: {
        json: { type: 'boolean', default: false },
        level: { type: 'string' },
        filter: { type: 'string' },
        concurrency: { type: 'string' },
        timeout: { type: 'string' },
        'no-multi-session': { type: 'boolean', default: false },
        'no-restart': { type: 'boolean', default: false },
        list: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
    }));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let levels: Level[] | undefined;
  if (values.level) {
    levels = values.level.split(',').map((s) => s.trim()) as Level[];
    const bad = levels.filter((l) => !(LEVELS as readonly string[]).includes(l));
    if (bad.length > 0) {
      process.stderr.write(`unknown level: ${bad.join(', ')}\n`);
      return 2;
    }
  }
  const num = (v: string | undefined, name: string): number | undefined | 'bad' => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) {
      process.stderr.write(`--${name} needs a positive number\n`);
      return 'bad';
    }
    return n;
  };
  const concurrency = num(values.concurrency, 'concurrency');
  const timeoutMs = num(values.timeout, 'timeout');
  if (concurrency === 'bad' || timeoutMs === 'bad') return 2;

  if (values.list) {
    for (const t of ALL_TESTS) {
      process.stdout.write(
        `${t.level.padEnd(10)} ${t.id}${t.requires ? `  (requires ${t.requires.join(', ')})` : ''}\n`,
      );
    }
    return 0;
  }

  const [command, ...args] = hostCmd;
  const launcher = command
    ? new ProcessLauncher(command, args, {
        multiSession: !values['no-multi-session'],
        restart: !values['no-restart'],
      })
    : new InProcessLauncher();

  const onResult = values.json
    ? undefined
    : (r: TestResult): void => {
        process.stderr.write(`${r.status === 'passed' ? '.' : r.status === 'failed' ? 'F' : 's'}`);
      };
  let report;
  try {
    report = await runSuite({
      launcher,
      ...(levels ? { levels } : {}),
      ...(values.filter ? { filter: values.filter } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(onResult ? { onResult } : {}),
    });
  } catch (e) {
    process.stderr.write(
      `\nconformance run aborted: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 1;
  }
  if (!values.json) process.stderr.write('\n\n');
  process.stdout.write(`${values.json ? formatJson(report) : formatHuman(report)}\n`);
  return report.totals.failed > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  },
);
