/**
 * Framework-free conformance test registry and the launcher contract.
 *
 * A {@link ConformanceTest} is a plain object; nothing here depends on vitest, jest or any other
 * runner. A {@link HostLauncher} gives every test a fresh, isolated host: this is the single
 * integration point for third-party hosts (see the package README).
 */
import type { AepClient } from '@aep/client';
import type { Scope } from '@aep/schema';
import type { TestContext } from './context.js';

/** Conformance levels. A level is achieved when none of its tests fail and at least one passes. */
export const LEVELS = [
  'core',
  'audio',
  'proposals',
  'history',
  'assets',
  'jobs',
  'security',
] as const;
export type Level = (typeof LEVELS)[number];

export type Role = 'read' | 'propose' | 'edit' | 'admin';

export interface SessionSpec {
  role: Role;
  scope?: Scope;
}

export interface LaunchOptions {
  /** Project JSON the host starts with (a full, schema-valid AEP `Project`). */
  fixture?: unknown;
  /** One entry per session the test needs. Session `i` is served to `clients[i]`. */
  sessions: SessionSpec[];
}

export interface LaunchedHost {
  /** One connected client per requested session, in order. */
  clients: AepClient[];
  /** The credential of each session, in order. Used only to prove it is never echoed. */
  credentials: string[];
  /** Stop the host and delete everything the launcher created. */
  close(): Promise<void>;
}

export interface HostLauncher {
  /** Human-readable description, shown in the report. */
  readonly name: string;
  /** Start a fresh host. Throw {@link UnsupportedLaunch} if the request cannot be satisfied. */
  launch(opts: LaunchOptions): Promise<LaunchedHost>;
}

/** Thrown by a launcher that cannot satisfy a request (e.g. several sessions); the test is skipped. */
export class UnsupportedLaunch extends Error {
  override readonly name = 'UnsupportedLaunch';
}

export interface ConformanceTest {
  /** Stable id, `<level>.<area>.<name>`. */
  id: string;
  title: string;
  level: Level;
  /** Capability ids that must appear in `aep.capabilities`; otherwise the test is skipped. */
  requires?: string[];
  /** Sessions to grant. Default: one `edit` session. */
  sessions?: SessionSpec[];
  run(ctx: TestContext): Promise<void>;
}

/** An ordered, id-unique collection of tests. Third parties may register their own. */
export class TestRegistry {
  private readonly byId = new Map<string, ConformanceTest>();

  constructor(tests: Iterable<ConformanceTest> = []) {
    for (const t of tests) this.register(t);
  }

  register(test: ConformanceTest): this {
    if (this.byId.has(test.id)) throw new Error(`duplicate conformance test id '${test.id}'`);
    this.byId.set(test.id, test);
    return this;
  }

  all(): ConformanceTest[] {
    return [...this.byId.values()];
  }

  level(level: Level): ConformanceTest[] {
    return this.all().filter((t) => t.level === level);
  }
}
