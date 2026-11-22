/**
 * Shared helpers for the engine tests. Every result the host returns through `TestClient.call`
 * is validated with `CoreResult.parse` (definition-of-done item 11).
 */
import { CORE_PROTOCOL, CoreResult } from '@aep/schema';
import type { Operation, Scope } from '@aep/schema';
import { demoProject } from '../domain/fixtures.js';
import { AepHost } from './host.js';
import type { AepHostOptions, CreateSessionOptions } from './host.js';
import { referenceExecutors } from './fixture-executors.js';

export class TestClock {
  constructor(public now = 1_700_000_000_000) {}
  readonly read = (): number => this.now;
  advance(ms: number): void {
    this.now += ms;
  }
}

export interface CallOptions {
  id?: string;
  baseRevision?: string | null;
  version?: number;
  credential?: string;
  session?: string;
  workspace?: string;
}

export class TestClient {
  private seq = 0;
  constructor(
    readonly host: AepHost,
    readonly session: string,
    readonly credential: string,
    readonly workspace: string,
  ) {}

  nextId(): string {
    this.seq += 1;
    return `req-${this.session.slice(-6)}-${this.seq}`;
  }

  /** The raw request this client would send. */
  request(
    action: string,
    params: Record<string, unknown> = {},
    opts: CallOptions = {},
  ): Record<string, unknown> {
    const base = opts.baseRevision === undefined ? undefined : opts.baseRevision;
    return {
      protocol: CORE_PROTOCOL,
      session: opts.session ?? this.session,
      workspace: opts.workspace ?? this.workspace,
      id: opts.id ?? this.nextId(),
      credential: opts.credential ?? this.credential,
      action,
      version: opts.version ?? 1,
      ...(base !== undefined && base !== null ? { baseRevision: base } : {}),
      params,
    };
  }

  /** Send a request; the result is always schema-validated. */
  async call(
    action: string,
    params: Record<string, unknown> = {},
    opts: CallOptions = {},
  ): Promise<CoreResult> {
    return parseResult(await this.host.handle(this.request(action, params, opts)));
  }

  /** Like `call`, but uses the host's current revision as `baseRevision` unless given. */
  async write(
    action: string,
    params: Record<string, unknown>,
    opts: CallOptions = {},
  ): Promise<CoreResult> {
    const baseRevision = opts.baseRevision === undefined ? this.host.revision : opts.baseRevision;
    return this.call(action, params, { ...opts, baseRevision });
  }

  commit(
    operations: unknown[],
    extra: { scope?: Scope; label?: string } = {},
    opts: CallOptions = {},
  ): Promise<CoreResult> {
    return this.write('transaction.commit', { transaction: { operations, ...extra } }, opts);
  }

  propose(
    operations: unknown[],
    extra: { scope?: Scope; label?: string; proposalId?: string } = {},
    opts: CallOptions = {},
  ): Promise<CoreResult> {
    const { proposalId, ...tx } = extra;
    return this.write(
      'proposal.create',
      { transaction: { operations, ...tx }, ...(proposalId ? { proposalId } : {}) },
      opts,
    );
  }
}

export function parseResult(raw: unknown): CoreResult {
  return CoreResult.parse(raw);
}

/** Deliberately loose: tests probe action outputs that were already schema-validated. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Loose = any;

export const output = <T = Loose>(r: CoreResult): T => {
  if (r.status !== 'succeeded')
    throw new Error(`expected success, got ${r.status}: ${JSON.stringify(r.error)}`);
  return r.output as T;
};

export const errorCode = (r: CoreResult): string | undefined => r.error?.code;

export interface Fixture {
  host: AepHost;
  clock: TestClock;
  grant(opts: Partial<CreateSessionOptions> & { role: CreateSessionOptions['role'] }): TestClient;
  admin: TestClient;
  editor: TestClient;
  proposer: TestClient;
  reader: TestClient;
}

export function makeFixture(options: Partial<AepHostOptions> = {}): Fixture {
  const clock = new TestClock();
  const host = new AepHost({
    project: demoProject(),
    clock: clock.read,
    executors: referenceExecutors(),
    assertResults: true,
    ...options,
  });
  const grant: Fixture['grant'] = (opts) => {
    const g = host.createSession({ client: opts.client ?? `client-${opts.role}`, ...opts });
    return new TestClient(host, g.session, g.credential, g.workspace);
  };
  return {
    host,
    clock,
    grant,
    admin: grant({ role: 'admin' }),
    editor: grant({ role: 'edit' }),
    proposer: grant({ role: 'propose' }),
    reader: grant({ role: 'read' }),
  };
}

// ---- operation builders (plain JSON; the host validates them) ---------------------------------

export const noteUpdate = (
  noteId: string,
  patch: Record<string, unknown>,
  clipId = 'c-midi',
): Operation => ({ op: 'midi.notes.update', clipId, updates: [{ noteId, patch }] }) as Operation;

export const renameTrack = (trackId: string, name: string): Operation =>
  ({ op: 'track.update', trackId, patch: { name } }) as Operation;

export const renameClip = (clipId: string, name: string): Operation =>
  ({ op: 'clip.update', clipId, patch: { name } }) as Operation;
