/**
 * What a conformance test sees: connected clients for a fresh host, request helpers and
 * assertions. Everything goes through the public wire protocol (CoreRequest / CoreResult), never
 * through host internals, so the same tests run against any host.
 */
import type { AepClient } from '@wty.dev/aep-client';
import { canonicalJson, generateId } from '@wty.dev/aep-core';
import { ACTIONS, CORE_PROTOCOL, CoreResult, NO_BASE_REVISION_ACTIONS } from '@wty.dev/aep-schema';
import type { ActionName, CoreRequest, NextStep, Project } from '@wty.dev/aep-schema';
import type { LaunchedHost } from './suite.js';

/** Deliberately loose: outputs are schema-checked where it matters, then probed by tests. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Loose = any;

/** An assertion failed. */
export class ConformanceFailure extends Error {
  override readonly name = 'ConformanceFailure';
}

/** Thrown by {@link TestContext.skip}: the test cannot run against this host. */
export class SkipTest extends Error {
  override readonly name = 'SkipTest';
}

export interface CallOptions {
  /** Index of the session/client to use. Default 0. */
  client?: number;
  /** Request id (idempotency key). Default: a fresh random id. */
  id?: string;
  /** Explicit `baseRevision`. Default for writes: the host's current revision, read just before. */
  base?: string;
}

export interface ContextInit {
  launched: LaunchedHost;
  fixture: Project;
  capabilities: ReadonlySet<string>;
}

const short = (v: unknown): string => {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  return s.length > 400 ? `${s.slice(0, 400)}…` : s;
};

export class TestContext {
  readonly clients: AepClient[];
  readonly credentials: string[];
  /** The project the host was started with. */
  readonly fixture: Project;
  /** Capability ids from `aep.capabilities`. */
  readonly capabilities: ReadonlySet<string>;

  private readonly launched: LaunchedHost;

  constructor(init: ContextInit) {
    this.launched = init.launched;
    this.clients = init.launched.clients;
    this.credentials = init.launched.credentials;
    this.fixture = init.fixture;
    this.capabilities = init.capabilities;
  }

  /** The first (usually the only) client. */
  get client(): AepClient {
    return this.at(0);
  }

  at(index = 0): AepClient {
    const c = this.clients[index];
    if (!c) throw new ConformanceFailure(`test needs session #${index} but it was not granted`);
    return c;
  }

  credential(index = 0): string {
    const c = this.credentials[index];
    if (c === undefined) throw new ConformanceFailure(`no credential for session #${index}`);
    return c;
  }

  has(capability: string): boolean {
    return this.capabilities.has(capability);
  }

  /** Skip the rest of the test (reported as SKIP with the reason). */
  skip(reason: string): never {
    throw new SkipTest(reason);
  }

  skipUnless(capability: string): void {
    if (!this.has(capability)) this.skip(`host does not declare capability '${capability}'`);
  }

  /**
   * Kill the host and start it again over the same data directory (tests with `restart: true`).
   * `clients` and `credentials` are replaced in place; sessions are expected to survive.
   */
  async restart(): Promise<void> {
    if (!this.launched.restart) throw new ConformanceFailure('the launcher cannot restart hosts');
    await this.launched.restart();
  }

  /** A request id / entity id that is unique within this test. */
  uid(prefix = 'x'): string {
    return generateId(prefix);
  }

  async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  // ------------------------------------------------------------------ requests

  /** Current revision, read through the given session. */
  async revision(index = 0): Promise<string> {
    const r = await this.at(index).request('project.describe', {});
    if (r.status !== 'succeeded' || r.revision === undefined) {
      throw new ConformanceFailure(`could not read the revision: ${short(r)}`);
    }
    return r.revision;
  }

  /**
   * Send an action and return the raw {@link CoreResult}. Writes carry the current revision as
   * `baseRevision` unless `opts.base` says otherwise.
   */
  async call(action: ActionName, params: Loose = {}, opts: CallOptions = {}): Promise<CoreResult> {
    const index = opts.client ?? 0;
    const client = this.at(index);
    let base = opts.base;
    if (
      base === undefined &&
      ACTIONS[action].effect === 'write' &&
      !NO_BASE_REVISION_ACTIONS.has(action)
    ) {
      base = await this.revision(index);
    }
    const result = await client.request(action, params, {
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      ...(base !== undefined ? { baseRevision: base } : {}),
    });
    return CoreResult.parse(result);
  }

  /** Like {@link call} but requires success and returns the action output. */
  async callOk<T = Loose>(
    action: ActionName,
    params: Loose = {},
    opts: CallOptions = {},
  ): Promise<T> {
    return this.ok<T>(await this.call(action, params, opts), action);
  }

  /** Send a hand-built request (bad envelopes, unknown actions…). `undefined` values are dropped. */
  async raw(
    overrides: Record<string, unknown> = {},
    opts: { client?: number } = {},
  ): Promise<CoreResult> {
    const index = opts.client ?? 0;
    const client = this.at(index);
    const req: Record<string, unknown> = {
      protocol: CORE_PROTOCOL,
      session: client.session,
      workspace: client.workspace,
      id: this.uid('raw'),
      credential: this.credential(index),
      action: 'project.inspect',
      version: 1,
      params: {},
      ...overrides,
    };
    for (const k of Object.keys(req)) if (req[k] === undefined) delete req[k];
    return CoreResult.parse(await client.transport.send(req as unknown as CoreRequest));
  }

  commit(operations: Loose[], extra: Loose = {}, opts: CallOptions = {}): Promise<CoreResult> {
    return this.call('transaction.commit', { transaction: { operations, ...extra } }, opts);
  }

  /** Commit and return the receipt; fails the test if the commit is not accepted. */
  async commitOk(operations: Loose[], extra: Loose = {}, opts: CallOptions = {}): Promise<Loose> {
    return this.ok(await this.commit(operations, extra, opts), 'transaction.commit');
  }

  validate(operations: Loose[], extra: Loose = {}, opts: CallOptions = {}): Promise<CoreResult> {
    return this.call('transaction.validate', { transaction: { operations, ...extra } }, opts);
  }

  propose(
    operations: Loose[],
    extra: Loose & { proposalId?: string } = {},
    opts: CallOptions = {},
  ): Promise<CoreResult> {
    const { proposalId, ...tx } = extra;
    return this.call(
      'proposal.create',
      { transaction: { operations, ...tx }, ...(proposalId ? { proposalId } : {}) },
      opts,
    );
  }

  async proposeOk(operations: Loose[], extra: Loose = {}, opts: CallOptions = {}): Promise<Loose> {
    return this.ok(await this.propose(operations, extra, opts), 'proposal.create');
  }

  async inspect(index = 0): Promise<{ revision: string; project: Loose }> {
    return this.callOk('project.inspect', {}, { client: index });
  }

  async project(index = 0): Promise<Loose> {
    return (await this.inspect(index)).project;
  }

  async receipt(requestId: string, index = 0): Promise<Loose> {
    return this.callOk('receipt.get', { requestId }, { client: index });
  }

  async waitForJob(jobId: string, index = 0, timeoutMs = 20_000): Promise<Loose> {
    return this.at(index).waitForJob(jobId, { timeoutMs, pollMs: 25 });
  }

  // ------------------------------------------------------------------ entity lookups

  track(project: Loose, id: string): Loose {
    const t = project.tracks.find((x: Loose) => x.id === id);
    if (!t) throw new ConformanceFailure(`track '${id}' not found in project`);
    return t;
  }

  clip(project: Loose, id: string): Loose {
    for (const t of project.tracks) for (const c of t.clips) if (c.id === id) return c;
    throw new ConformanceFailure(`clip '${id}' not found in project`);
  }

  hasClip(project: Loose, id: string): boolean {
    return project.tracks.some((t: Loose) => t.clips.some((c: Loose) => c.id === id));
  }

  trackOfClip(project: Loose, id: string): Loose {
    for (const t of project.tracks) if (t.clips.some((c: Loose) => c.id === id)) return t;
    throw new ConformanceFailure(`clip '${id}' not found in project`);
  }

  trackIds(project: Loose): string[] {
    return project.tracks.map((t: Loose) => t.id);
  }

  // ------------------------------------------------------------------ assertions

  fail(message: string): never {
    throw new ConformanceFailure(message);
  }

  assert(condition: unknown, message: string): void {
    if (!condition) throw new ConformanceFailure(message);
  }

  /** Strict equality for primitives. */
  equal(actual: unknown, expected: unknown, what: string): void {
    if (actual !== expected) {
      throw new ConformanceFailure(`${what}: expected ${short(expected)}, got ${short(actual)}`);
    }
  }

  /** Numeric equality within an epsilon. */
  close(actual: unknown, expected: number, what: string, eps = 1e-6): void {
    if (typeof actual !== 'number' || Math.abs(actual - expected) > eps) {
      throw new ConformanceFailure(`${what}: expected ≈${expected}, got ${short(actual)}`);
    }
  }

  /** Structural JSON equality (key order does not matter). */
  same(actual: unknown, expected: unknown, what: string): void {
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new ConformanceFailure(
        `${what}: values differ\n  expected ${short(expected)}\n  actual   ${short(actual)}`,
      );
    }
  }

  differs(a: unknown, b: unknown, what: string): void {
    if (canonicalJson(a) === canonicalJson(b))
      throw new ConformanceFailure(`${what}: values are identical`);
  }

  /** The result succeeded; returns its output. */
  ok<T = Loose>(result: CoreResult, what = 'request'): T {
    if (result.status !== 'succeeded') {
      throw new ConformanceFailure(`${what}: expected success, got ${short(result)}`);
    }
    return result.output as T;
  }

  /** The result carries one of the error codes (and optionally the `next` hint). */
  expectError(
    result: CoreResult,
    code: string | string[],
    opts: { next?: NextStep; status?: 'rejected' | 'failed' } = {},
  ): void {
    const codes = Array.isArray(code) ? code : [code];
    const status = opts.status ?? 'rejected';
    if (result.status !== status) {
      throw new ConformanceFailure(
        `expected ${status} with error ${codes.join('|')}, got ${short(result)}`,
      );
    }
    if (!result.error || !codes.includes(result.error.code)) {
      throw new ConformanceFailure(`expected error ${codes.join('|')}, got ${short(result.error)}`);
    }
    if (opts.next !== undefined && result.error.next !== opts.next) {
      throw new ConformanceFailure(
        `error ${result.error.code}: expected next=${opts.next}, got next=${result.error.next}`,
      );
    }
    if (result.output !== undefined)
      throw new ConformanceFailure('a non-succeeded result carries output');
  }

  /** The project is unchanged since `before` (same revision, same content). */
  async expectUnchanged(
    before: { revision: string; project: Loose },
    what = 'project',
  ): Promise<void> {
    const now = await this.inspect();
    this.equal(now.revision, before.revision, `${what}: revision`);
    this.same(now.project, before.project, `${what}: content`);
  }
}
