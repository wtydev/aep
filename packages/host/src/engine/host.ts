import { constants as fsConstants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { FileHandle } from 'node:fs/promises';
import {
  AepError,
  applyChanges,
  clampMessage,
  constantTimeEqual,
  diffEntities,
  generateCredential,
  generateId,
  invertChanges,
  isAepError,
  negotiateVersion,
  RequestLedger,
  requestFingerprint,
  resolveInsideRoot,
  sha256Hex,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@wty.dev/aep-core';
import type { EntityMap, LedgerSnapshot } from '@wty.dev/aep-core';
import {
  ACTION_CAPABILITY,
  ACTION_NAMES,
  ACTION_VERSION,
  ACTIONS,
  actionSchemaName,
  beatsToSeconds,
  CORE_PROTOCOL,
  CoreRequest,
  CoreResult,
  Limits,
  NO_BASE_REVISION_ACTIONS,
  OPERATION_CAPABILITY,
  OPERATION_NAMES,
  PROTOCOL_VERSION,
  Project,
  ROLE_ACTIONS,
  sanitizeRequestId,
  Scope,
  SCHEMA_VERSION,
  secondsToBeats,
  TrackKind,
} from '@wty.dev/aep-schema';
import type {
  ActionName,
  CapabilitiesOutput,
  Change,
  CoreManifest,
  CoreState,
  Diagnostic,
  ErrorCode,
  GenerationRequestParams,
  HistoryEntry,
  Operation,
  Proposal,
  ProjectInput,
  Receipt,
  RenderRequestParams,
  ResultStatus,
  Transaction,
} from '@wty.dev/aep-schema';
import type { Project as ProjectT, Scope as ScopeT } from '@wty.dev/aep-schema';
import {
  checkScope,
  createdRemoved,
  applyOperations,
  flattenProject,
  unflattenProject,
  validateInvariants,
} from '../domain/index.js';
import type { ApplyContext } from '../domain/index.js';
import { AssetStore, IMPORTABLE_MEDIA_TYPES, mediaTypeFromName } from './assets.js';
import type { RequestHandler } from '@wty.dev/aep-core';
import { JobManager } from './jobs.js';
import type { JobExecutor, JobInput } from './jobs.js';
import { PersistenceError, StateFiles, STATE_FORMAT_VERSION } from './persistence.js';
import { assetBlobName, parsePersistedState } from './state.js';
import type { PersistedHistory, PersistedRequestRecord, PersistedState, Role } from './state.js';

export const DEFAULT_LIMITS: Limits = {
  maxOperationsPerTransaction: 1000,
  maxRequestBytes: 1_048_576,
  maxNotesPerClip: 100_000,
  maxTracks: 512,
  maxOpenProposals: 64,
  receiptRetention: 1000,
};

export const DEFAULT_HOST_INFO = { name: 'aep-reference-host', version: '1.0.0' } as const;
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTICS = 200;
const ABSENT_CREDENTIAL_HASH = sha256Hex('');
const GENERIC_INTERNAL = 'internal error while processing the request';

export interface AepHostOptions {
  project: ProjectInput;
  hostInfo?: { name: string; version: string };
  /** Declared capabilities. Default: every known capability the configured executors/roots support. */
  capabilities?: string[];
  limits?: Partial<Limits>;
  /** Import roots for `asset.import`: name → absolute directory. */
  importRoots?: Record<string, string>;
  executors?: JobExecutor[];
  /** Epoch-millisecond clock. Default `Date.now`. */
  clock?: () => number;
  /** Records kept per session in the request ledger / receipt log. Default `limits.receiptRetention`. */
  ledgerRetention?: number;
  /** Default lifetime of sessions created without `expiresAt`. Default 1 hour. */
  sessionTtlMs?: number;
  /** Largest file `asset.import` accepts, in bytes. Default 64 MiB. */
  maxAssetBytes?: number;
  /** Validate every result against the CoreResult and action output schemas. Default: not production. */
  assertResults?: boolean;
  /** Called with the real error behind an `internal_error` result (never sent to clients). */
  onInternalError?: (error: unknown, request: { action: string; id: string }) => void;
}

/** Options for {@link AepHost.open}: a durable host whose state lives under `dataDir`. */
export interface DurableHostOptions extends AepHostOptions {
  /** Absolute directory for durable state (created with mode 0700). */
  dataDir: string;
}

export interface CreateSessionOptions {
  client: string;
  role: Role;
  scope?: ScopeT;
  allowedActions?: string[];
  /** Epoch ms. */
  expiresAt?: number;
}

export interface SessionGrant {
  session: string;
  /** Returned once. The host keeps only a hash. */
  credential: string;
  workspace: string;
}

interface SessionRecord {
  id: string;
  client: string;
  role: Role;
  scope?: ScopeT;
  allowedActions?: ReadonlySet<string>;
  expiresAt: number;
  revoked: boolean;
  credentialHash: string;
}

interface Snapshot {
  project: ProjectT;
  entities: EntityMap;
  revision: string;
}

interface HistoryRecord {
  entry: HistoryEntry;
  changes: Change[];
  /** Session that made the commit; request ids are only unique per session. */
  sessionId: string;
  /** For undo/redo entries: the exact record they reverted or reapplied. */
  target?: HistoryRecord;
}

interface ProposalRecord {
  proposal: Proposal;
  /** Proposed state; dropped once the proposal is closed. */
  proposed?: ProjectT;
  proposerScope?: ScopeT;
}

interface RequestRecord {
  action: string;
  status: ResultStatus;
  errorCode?: string;
  diagnostics: Diagnostic[];
  receipt?: Receipt;
}

interface Outcome {
  output: unknown;
  /** Reverses an effect that lives outside the checkpointed state (asset store, job table). */
  undo?: () => void;
  /** The effect cannot be reversed (`job.cancel`); a failed persist then yields `outcome_uncertain`. */
  irreversible?: boolean;
  /** Runs once the effect is kept (persisted, or kept as `outcome_uncertain`): starts jobs. */
  afterCommit?: () => void;
  /** Revision for the result; default: the current revision. */
  revision?: string;
  diagnostics?: Diagnostic[];
  receipt?: Receipt;
}

/** Outcome of an action whose output is the receipt of the commit it made. */
const receiptOutcome = (receipt: Receipt): Outcome => ({
  output: receipt,
  revision: receipt.revision,
  receipt,
});

interface Evaluated {
  project: ProjectT;
  entities: EntityMap;
  changes: Change[];
}

interface Parseable {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { issues: readonly { path: PropertyKey[]; message: string }[] } };
}

function clampDiagnostics(diags: readonly Diagnostic[]): Diagnostic[] {
  return diags
    .slice(0, MAX_DIAGNOSTICS)
    .map((d) => ({ ...d, message: clampMessage(d.message) || d.code }));
}

/** In-memory state a durable write can be rolled back to. See `AepHost.checkpoint`. */
interface Checkpoint {
  current: Snapshot;
  revisionCounter: number;
  history: { rec: HistoryRecord; entry: HistoryEntry }[];
  proposals: {
    id: string;
    rec: ProposalRecord;
    proposal: Proposal;
    proposed: ProjectT | undefined;
  }[];
  ledger: LedgerSnapshot;
  records: Map<string, Map<string, RequestRecord>>;
}

const reservationKey = (session: string, id: string): string => JSON.stringify([session, id]);

const jsonPath = (path: readonly PropertyKey[]): string =>
  path.length === 0
    ? '/'
    : '/' + path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

/** Hands `AepHost.open`'s storage to the constructor without making it a public parameter. */
const openingFiles = new WeakMap<AepHostOptions, StateFiles>();

/**
 * Reference AEP host engine: sessions, transactions, proposals, history, assets and jobs over
 * one project. Implements the host side of the AEP envelope (`RequestHandler`). Every commit is
 * a single reference swap, so a request that fails can never leave partial state.
 *
 * Volatile by default (`new AepHost(...)`: everything in memory, `host.durability` is
 * `volatile`). `AepHost.open({ dataDir })` makes it durable: see "Durability" below.
 *
 * Durability. State is persisted as one JSON file plus content-addressed asset blobs (see
 * `persistence.ts`, `state.ts`). In durable mode every request runs under one mutex, so no
 * request observes another's half-finished work, and:
 *  - write-ahead: a `write` request the ledger reports as new is reserved on disk BEFORE any
 *    effect runs; the final state (project, history, receipt, ledger result) is on disk BEFORE
 *    the result is returned;
 *  - a reservation found without a result after a restart becomes an `outcome_uncertain`
 *    (indeterminate) result, so a retry never re-executes;
 *  - persistence failure policy: the effect is applied to memory first and rolled back from a
 *    checkpoint if the final write fails (equivalent to "persist, then swap", because requests
 *    are serialized and reads wait their turn). If the new state file cannot have reached disk,
 *    the request is rolled back and reported as `internal_error` (failed, retryable). If it may
 *    have (the directory sync after the rename failed) or the effect cannot be reversed
 *    (`job.cancel`), memory keeps the effect and the result is `outcome_uncertain`; the next
 *    successful write rewrites the whole state, resolving the ambiguity.
 * One host process must own a data directory; there is no cross-process lock.
 */
export class AepHost implements RequestHandler {
  readonly limits: Limits;
  readonly hostInfo: { name: string; version: string };
  readonly capabilities: ReadonlySet<string>;

  private readonly clock: () => number;
  private readonly sessionTtlMs: number;
  private readonly maxAssetBytes: number;
  private readonly assertResults: boolean;
  private readonly onInternalError?: AepHostOptions['onInternalError'];
  private readonly importRoots = new Map<string, string>();
  private readonly executors: JobExecutor[];
  private readonly retention: number;
  private readonly persistence?: StateFiles;

  private readonly sessions = new Map<string, SessionRecord>();
  private readonly ledger: RequestLedger;
  private readonly records = new Map<string, Map<string, RequestRecord>>();
  private readonly assets = new AssetStore();
  private readonly jobs: JobManager;
  private readonly proposals = new Map<string, ProposalRecord>();
  private readonly history: HistoryRecord[] = [];
  private readonly applyCtx: ApplyContext;

  /** Open reservations: action names, so `receipt.get` can describe an interrupted request. */
  private readonly reservations = new Map<
    string,
    { session: string; id: string; action: string }
  >();
  private requestChain: Promise<unknown> = Promise.resolve();
  private dirtyVersion = 0;
  private persistedVersion = 0;

  private current: Snapshot;
  /** Set while a durable write's effect is applied in memory but not yet persisted. */
  private tentative: Snapshot | undefined;
  /** Storage failed in a way that left disk and memory disagreeing: refuse all requests. */
  private storageBroken = false;
  private revisionCounter = 0;

  /** Creates a volatile host. For a durable one use {@link AepHost.open}. */
  constructor(options: AepHostOptions) {
    const persistence = openingFiles.get(options);
    openingFiles.delete(options);
    this.persistence = persistence;
    if ('dataDir' in options && persistence === undefined) {
      throw new TypeError(
        'AepHost: the constructor creates volatile hosts only; use `await AepHost.open({ dataDir, ... })` for a durable host',
      );
    }
    this.limits = Limits.parse({ ...DEFAULT_LIMITS, ...options.limits });
    this.hostInfo = options.hostInfo ?? { ...DEFAULT_HOST_INFO };
    this.clock = options.clock ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxAssetBytes = options.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;
    this.assertResults = options.assertResults ?? process.env['NODE_ENV'] !== 'production';
    this.onInternalError = options.onInternalError;
    this.executors = [...(options.executors ?? [])];
    this.retention = options.ledgerRetention ?? this.limits.receiptRetention;
    for (const [name, dir] of Object.entries(options.importRoots ?? {}))
      this.importRoots.set(name, dir);
    this.ledger = new RequestLedger({ retention: this.retention });
    this.jobs = new JobManager({
      assets: this.assets,
      clock: this.clock,
      onSettled: () => this.schedulePersist(),
    });

    // Check invariants (including id uniqueness) before flattening: flattening keys entities by
    // id, so a duplicate id would otherwise be dropped silently.
    const initial = Project.parse(options.project);
    this.assertInvariants(initial, 'validation_failed');
    const entities = flattenProject(initial);
    this.current = { project: unflattenProject(entities), entities, revision: this.revisionId() };

    const caps = new Set(options.capabilities ?? this.defaultCapabilities());
    caps.add('aep.core');
    this.capabilities = caps;
    this.applyCtx = {
      capabilities: this.capabilities,
      limits: this.limits,
      lookupStoreAsset: (id) => this.assets.get(id),
    };
  }

  /**
   * Open a durable host over `options.dataDir` (an absolute path, created with mode 0700).
   * If `<dataDir>/host-state.json` exists the host is restored from it and `options.project`
   * is ignored; otherwise it starts from `options.project` and persists immediately. Throws on
   * an unknown `formatVersion`, a malformed file, or asset bytes that do not match their hash.
   */
  static async open(options: DurableHostOptions): Promise<AepHost> {
    const { dataDir, ...rest } = options;
    if (!isAbsolute(dataDir)) throw new RangeError('dataDir must be an absolute path');
    const files = await StateFiles.open(dataDir);
    const construct = (project: AepHostOptions['project']): AepHost => {
      const opts: AepHostOptions = { ...rest, project };
      openingFiles.set(opts, files);
      return new AepHost(opts);
    };
    const raw = await files.readState();
    if (raw === undefined) {
      const host = construct(options.project);
      host.markDirty();
      await host.persistNow();
      return host;
    }
    const state = parsePersistedState(raw);
    const blobs = new Map<string, Uint8Array>();
    for (const asset of state.assets) {
      const name = assetBlobName(asset);
      if (!blobs.has(name)) blobs.set(name, await files.readBlob(name));
    }
    const host = construct(state.project);
    if (host.loadState(state, blobs)) {
      host.markDirty();
      await host.persistNow();
    }
    return host;
  }

  /** Resolves once every state change made so far is on disk. Rejects if writing fails. No-op when volatile. */
  async flush(): Promise<void> {
    if (!this.persistence) return;
    await this.exclusive(() => this.persistIfDirty());
  }

  // ---------------------------------------------------------------- public surface

  get projectId(): string {
    return this.current.project.id;
  }

  /** Accepted revision. While a durable write awaits its final persist, the previous one. */
  get revision(): string {
    return this.committed.revision;
  }

  /** The state clients may observe: excludes the effect of a write that is not yet durable. */
  private get committed(): Snapshot {
    return this.tentative ?? this.current;
  }

  /**
   * Out-of-band session creation (design §6). The credential is returned exactly once.
   *
   * On a durable host the session is written in the background; `await host.flush()` before
   * handing the credential out (or before a crash can matter) to know it is on disk.
   */
  createSession(opts: CreateSessionOptions): SessionGrant {
    if (opts.client.length === 0 || opts.client.length > 128) {
      throw new RangeError('client name must be 1..128 characters');
    }
    const scope = opts.scope === undefined ? undefined : Scope.parse(opts.scope);
    for (const a of opts.allowedActions ?? []) {
      if (!Object.hasOwn(ACTIONS, a))
        throw new RangeError(`unknown action '${a}' in allowedActions`);
    }
    if (
      opts.expiresAt !== undefined &&
      (!Number.isSafeInteger(opts.expiresAt) || opts.expiresAt < 0)
    ) {
      throw new RangeError('expiresAt must be a non-negative integer (epoch milliseconds)');
    }
    const id = generateId('sess');
    const credential = generateCredential();
    this.sessions.set(id, {
      id,
      client: opts.client,
      role: opts.role,
      ...(scope ? { scope } : {}),
      ...(opts.allowedActions ? { allowedActions: new Set(opts.allowedActions) } : {}),
      expiresAt: opts.expiresAt ?? this.clock() + this.sessionTtlMs,
      revoked: false,
      credentialHash: sha256Hex(credential),
    });
    this.schedulePersist();
    return { session: id, credential, workspace: this.projectId };
  }

  /** Revoke a session now (in memory); on a durable host it is on disk only after `await host.flush()`. */
  revokeSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new AepError('not_authorized', 'unknown session');
    s.revoked = true;
    this.schedulePersist();
  }

  /** Session manifest listing only the actions that session may use. */
  manifest(sessionId?: string): CoreManifest {
    const s = this.resolveSession(sessionId);
    const actions = ACTION_NAMES.filter((a) => this.permits(s, a)).map((a) => ({
      id: a,
      version: ACTION_VERSION,
      effect: ACTIONS[a].effect,
      paramsSchema: `schemas/${actionSchemaName(a, 'params')}.schema.json`,
      resultSchema: `schemas/${actionSchemaName(a, 'result')}.schema.json`,
    }));
    return {
      protocol: CORE_PROTOCOL,
      session: s.id,
      workspace: this.projectId,
      expiresAt: s.expiresAt,
      actions,
      stateSchema: 'schemas/project.schema.json',
    };
  }

  /** Accepted-state snapshot: `data` is the project. */
  state(sessionId?: string): CoreState & { data: ProjectT } {
    const s = this.resolveSession(sessionId);
    return {
      protocol: CORE_PROTOCOL,
      session: s.id,
      workspace: this.projectId,
      revision: this.committed.revision,
      data: structuredClone(this.committed.project),
    };
  }

  /**
   * A `RequestHandler` bound to one session, for single-session transports (directory, stdio)
   * whose `manifest()`/`state()` take no argument.
   */
  forSession(sessionId: string): RequestHandler {
    this.resolveSession(sessionId);
    return {
      handle: (raw) => this.handle(raw),
      manifest: () => this.manifest(sessionId),
      state: () => this.state(sessionId),
    };
  }

  /** Resolves when all queued/running jobs have reached a terminal state. */
  async waitForJobs(): Promise<void> {
    await this.jobs.idle();
    await this.flush();
  }

  // ---------------------------------------------------------------- request pipeline (design §1)

  handle(raw: unknown): Promise<CoreResult> {
    return this.persistence ? this.exclusive(() => this.handleCore(raw)) : this.handleCore(raw);
  }

  private async handleCore(raw: unknown): Promise<CoreResult> {
    if (this.storageBroken) {
      const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      return this.failure(
        {
          session: sanitizeRequestId(r['session']),
          workspace: sanitizeRequestId(r['workspace']),
          id: sanitizeRequestId(r['id']),
        },
        new AepError(
          'internal_error',
          'host storage failed; the host must be restarted before it can serve requests',
        ),
        undefined,
      );
    }
    // 1. envelope
    const parsed = CoreRequest.safeParse(raw);
    if (!parsed.success) {
      const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      const issue = parsed.error.issues[0];
      const where = issue ? ` (${jsonPath(issue.path)}: ${issue.message})` : '';
      return this.failure(
        {
          session: sanitizeRequestId(r['session']),
          workspace: sanitizeRequestId(r['workspace']),
          id: sanitizeRequestId(r['id']),
        },
        new AepError('bad_request', `not a valid AEP request${where}`),
        undefined,
      );
    }
    const req = parsed.data;

    // 2. session
    const session = this.authenticate(req);
    if (isAepError(session)) return this.failure(req, session, undefined);

    // 3. action, 4. size
    const early = this.checkAction(session, req);
    if (early) return this.failure(req, early, this.current.revision);

    // 5. ledger
    const begin = this.ledger.begin(req.session, req.id, requestFingerprint(req));
    if (begin.kind === 'replay') {
      // The ledger just moved this id to most-recent; keep the receipt index in the same order so
      // both evict the same request.
      const perSession = this.records.get(req.session);
      const rec = perSession?.get(req.id);
      if (perSession && rec) {
        perSession.delete(req.id);
        perSession.set(req.id, rec);
      }
      return structuredClone(begin.result);
    }
    if (begin.kind === 'pending') {
      return this.failure(
        req,
        new AepError('busy', `request '${req.id}' is still being processed`),
        this.current.revision,
      );
    }
    if (begin.kind === 'conflict') {
      return this.failure(
        req,
        new AepError(
          'id_conflict',
          `request id '${req.id}' was already used with a different request`,
        ),
        this.current.revision,
      );
    }

    // 5b. durable: reserve before any effect (write-ahead)
    const durable = this.persistence !== undefined;
    const isWrite = ACTIONS[req.action as ActionName].effect === 'write';
    const key = reservationKey(req.session, req.id);
    if (durable && isWrite) {
      this.reservations.set(key, { session: req.session, id: req.id, action: req.action });
      this.markDirty();
      try {
        await this.persistNow();
      } catch (e) {
        // Nothing ran. Forget the reservation so a retry executes as a new request.
        this.reservations.delete(key);
        this.ledger.abandon(req.session, req.id);
        this.reportInternal(e, req);
        return this.persistFailure(req);
      }
    }
    const checkpoint = durable && isWrite ? this.checkpoint() : undefined;
    if (checkpoint) this.tentative = checkpoint.current;

    // 6-8. params, base revision, execute
    let result: CoreResult;
    let record: RequestRecord;
    let outcome: Outcome | undefined;
    try {
      outcome = await this.run(session, req);
      result = {
        protocol: CORE_PROTOCOL,
        session: req.session,
        workspace: req.workspace,
        id: req.id,
        status: 'succeeded',
        revision: outcome.revision ?? this.current.revision,
        output: outcome.output,
      };
      record = {
        action: req.action,
        status: 'succeeded',
        diagnostics: clampDiagnostics(outcome.diagnostics ?? []),
        ...(outcome.receipt ? { receipt: outcome.receipt } : {}),
      };
    } catch (e) {
      const err = this.toAepError(e, req);
      result = this.failure(req, err, this.current.revision);
      record = {
        action: req.action,
        status: err.status,
        errorCode: err.code,
        diagnostics: clampDiagnostics(this.diagnosticsOf(err)),
      };
    }

    // 9. store, then (durable writes) make the final state durable before answering
    let final: CoreResult;
    try {
      final = this.finalize(req, result, record);
    } catch (problem) {
      this.tentative = undefined;
      if (durable) await this.persistNow().catch(() => undefined);
      throw problem;
    }
    if (checkpoint) {
      try {
        await this.persistNow();
      } catch (e) {
        this.reportInternal(e, req);
        // A rejected action may still have changed state before it threw (proposal.accept marks
        // a conflicting proposal stale), so rejections are rolled back like successes.
        return await this.afterFailedPersist(req, e, checkpoint, outcome, record);
      } finally {
        this.tentative = undefined;
      }
    }
    outcome?.afterCommit?.();
    return final;
  }

  // ---------------------------------------------------------------- durability

  /** Run `fn` after every earlier exclusive task. Used for all requests of a durable host. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.requestChain.then(fn);
    this.requestChain = run.catch(() => undefined);
    return run;
  }

  private markDirty(): void {
    this.dirtyVersion += 1;
  }

  /** Mark dirty and write in the background (sessions, job completion). `flush()` surfaces errors. */
  private schedulePersist(): void {
    this.markDirty();
    if (!this.persistence) return;
    this.exclusive(() => this.persistIfDirty()).catch((e: unknown) => {
      this.reportInternal(e, { action: 'host.persist', id: 'background' });
    });
  }

  private async persistIfDirty(): Promise<void> {
    if (this.dirtyVersion !== this.persistedVersion) await this.persistNow();
  }

  /**
   * Write the whole current state. Callers hold the request mutex (`exclusive`), or run before
   * the host is handed out (`open`), so two writes never interleave.
   */
  private async persistNow(): Promise<void> {
    const files = this.persistence;
    if (!files) return;
    const version = this.dirtyVersion;
    const { state, blobs } = this.serializeState();
    await files.write(state, blobs);
    this.persistedVersion = version;
  }

  /** Hand the real error behind an `internal_error` to `onInternalError`; never throws. */
  private reportInternal(e: unknown, req: { action: string; id: string }): void {
    try {
      this.onInternalError?.(e, { action: req.action, id: req.id });
    } catch {
      // a faulty logging hook must not change the outcome
    }
  }

  /** Result for a request that could not be reserved: nothing ran, nothing is recorded. */
  private persistFailure(req: CoreRequest): CoreResult {
    return this.failure(
      req,
      new AepError(
        'internal_error',
        'host state could not be persisted; the request was not applied',
        [{ code: 'internal_error', message: 'host state could not be persisted' }],
      ),
      this.current.revision,
    );
  }

  /**
   * The final state of a succeeded write could not be persisted. If it cannot have reached disk
   * and the effect is reversible, undo it and report `internal_error` (retryable). Otherwise keep
   * the effect, record `outcome_uncertain` in its place and let the next write resolve the doubt.
   */
  private async afterFailedPersist(
    req: CoreRequest,
    e: unknown,
    cp: Checkpoint,
    outcome: Outcome | undefined,
    record: RequestRecord,
  ): Promise<CoreResult> {
    this.markDirty();
    const mayBeOnDisk = e instanceof PersistenceError && e.committed;
    this.rollbackBookkeeping(cp);
    if (!mayBeOnDisk && !outcome?.irreversible) {
      this.rollbackState(cp);
      outcome?.undo?.();
      this.ledger.abandon(req.session, req.id);
      this.reservations.delete(reservationKey(req.session, req.id));
      return this.persistFailure(req);
    }
    const err = new AepError(
      'outcome_uncertain',
      `request '${req.id}' may have been applied but could not be made durable; reconcile with receipt.get or project.inspect`,
    );
    const uncertain = this.failure(req, err, this.current.revision);
    this.store(req, uncertain, {
      action: req.action,
      status: 'indeterminate',
      errorCode: err.code,
      diagnostics: clampDiagnostics(this.diagnosticsOf(err)),
      ...(record.receipt ? { receipt: record.receipt } : {}),
    });
    outcome?.afterCommit?.();
    if (mayBeOnDisk) {
      // The renamed state file (with the original result) may survive a crash. Replace it with
      // the uncertain one so a replay after restart gives the same answer; if that fails too,
      // disk and memory may disagree, so stop serving until the host is restarted.
      try {
        await this.persistNow();
      } catch (again) {
        this.storageBroken = true;
        this.reportInternal(again, req);
      }
    }
    return structuredClone(uncertain);
  }

  /** Capture what `rollbackState` / `rollbackBookkeeping` need. Taken after the reservation is written. */
  private checkpoint(): Checkpoint {
    return {
      current: this.current,
      revisionCounter: this.revisionCounter,
      history: this.history.map((rec) => ({ rec, entry: { ...rec.entry } })),
      proposals: [...this.proposals].map(([id, rec]) => ({
        id,
        rec,
        proposal: rec.proposal,
        proposed: rec.proposed,
      })),
      ledger: this.ledger.snapshot(),
      records: new Map([...this.records].map(([session, m]) => [session, new Map(m)])),
    };
  }

  /** Restore the ledger and request records (the request is pending again). */
  private rollbackBookkeeping(cp: Checkpoint): void {
    this.ledger.restore(cp.ledger);
    this.records.clear();
    for (const [session, m] of cp.records) this.records.set(session, new Map(m));
  }

  /** Restore project, revision, history and proposals. */
  private rollbackState(cp: Checkpoint): void {
    this.current = cp.current;
    this.revisionCounter = cp.revisionCounter;
    this.history.length = 0;
    for (const h of cp.history) {
      h.rec.entry = h.entry;
      this.history.push(h.rec);
    }
    this.proposals.clear();
    for (const p of cp.proposals) {
      p.rec.proposal = p.proposal;
      if (p.proposed) p.rec.proposed = p.proposed;
      else delete p.rec.proposed;
      this.proposals.set(p.id, p.rec);
    }
  }

  private serializeState(): { state: PersistedState; blobs: [string, Uint8Array][] } {
    const index = new Map<HistoryRecord, number>();
    this.history.forEach((h, i) => index.set(h, i));
    const history: PersistedHistory[] = this.history.map((h) => {
      const target = h.target === undefined ? undefined : index.get(h.target);
      return {
        entry: h.entry,
        changes: h.changes,
        sessionId: h.sessionId,
        ...(target !== undefined ? { target } : {}),
      };
    });
    const assets = this.assets.entries();
    const state: PersistedState = {
      formatVersion: STATE_FORMAT_VERSION,
      project: this.current.project,
      revision: this.current.revision,
      revisionCounter: this.revisionCounter,
      sessions: [...this.sessions.values()].map((s) => ({
        id: s.id,
        client: s.client,
        role: s.role,
        ...(s.scope ? { scope: s.scope } : {}),
        ...(s.allowedActions ? { allowedActions: [...s.allowedActions] } : {}),
        expiresAt: s.expiresAt,
        revoked: s.revoked,
        credentialHash: s.credentialHash,
      })),
      ledger: this.ledger.snapshot(),
      reservations: [...this.reservations.values()],
      records: [...this.records].map(([session, m]) => ({
        session,
        records: [...m].map(([id, r]): { id: string; record: PersistedRequestRecord } => ({
          id,
          record: r,
        })),
      })),
      history,
      proposals: [...this.proposals.values()].map((p) => ({
        proposal: p.proposal,
        ...(p.proposed ? { proposed: p.proposed } : {}),
        ...(p.proposerScope ? { proposerScope: p.proposerScope } : {}),
      })),
      assets: assets.map((a) => a.asset),
      jobs: this.jobs.list(),
    };
    return {
      state,
      blobs: assets.map((a): [string, Uint8Array] => [assetBlobName(a.asset), a.bytes]),
    };
  }

  /**
   * Load restored state into this freshly constructed host. Returns true when the restore itself
   * changed something that must be written back (reservations and jobs that were interrupted).
   */
  private loadState(state: PersistedState, blobs: Map<string, Uint8Array>): boolean {
    // The constructor already parsed, checked and flattened `state.project`.
    this.current = { ...this.current, revision: state.revision };
    this.revisionCounter = state.revisionCounter;
    for (const s of state.sessions) {
      this.sessions.set(s.id, {
        id: s.id,
        client: s.client,
        role: s.role,
        ...(s.scope ? { scope: s.scope } : {}),
        ...(s.allowedActions ? { allowedActions: new Set(s.allowedActions) } : {}),
        expiresAt: s.expiresAt,
        revoked: s.revoked,
        credentialHash: s.credentialHash,
      });
    }
    this.ledger.restore(state.ledger);
    for (const { session, records } of state.records) {
      this.records.set(session, new Map(records.map((r) => [r.id, r.record])));
    }
    const restored = state.history.map((h): HistoryRecord => ({
      entry: h.entry,
      changes: h.changes,
      sessionId: h.sessionId,
    }));
    state.history.forEach((h, i) => {
      if (h.target !== undefined) restored[i]!.target = restored[h.target];
    });
    this.history.push(...restored);
    for (const p of state.proposals) {
      this.proposals.set(p.proposal.id, {
        proposal: p.proposal,
        ...(p.proposed ? { proposed: p.proposed } : {}),
        ...(p.proposerScope ? { proposerScope: p.proposerScope } : {}),
      });
    }
    for (const asset of state.assets) this.assets.restore(asset, blobs.get(assetBlobName(asset))!);
    let changed = this.jobs.restore(state.jobs);

    // A reservation without a result: the effect may or may not have happened.
    const actions = new Map(
      state.reservations.map((r) => [reservationKey(r.session, r.id), r.action]),
    );
    for (const { session, id } of this.ledger.pendingIds()) {
      const action = actions.get(reservationKey(session, id)) ?? 'unknown';
      const err = new AepError(
        'outcome_uncertain',
        `the host stopped while processing request '${id}'; it may or may not have been applied`,
      );
      const result = this.failure(
        { session, workspace: this.projectId, id },
        err,
        this.current.revision,
      );
      this.ledger.complete(session, id, result);
      this.recordsFor(session).set(id, {
        action,
        status: 'indeterminate',
        errorCode: err.code,
        diagnostics: [{ code: err.code, message: err.message }],
      });
      changed = true;
    }
    return changed;
  }

  // ---------------------------------------------------------------- pipeline helpers

  private authenticate(req: CoreRequest): SessionRecord | AepError {
    const s = this.sessions.get(req.session);
    const matches = constantTimeEqual(
      sha256Hex(req.credential),
      s?.credentialHash ?? ABSENT_CREDENTIAL_HASH,
    );
    if (!s || !matches)
      return new AepError('not_authorized', 'unknown session or invalid credential');
    if (s.revoked) return new AepError('session_revoked', 'session has been revoked');
    if (this.clock() >= s.expiresAt) return new AepError('session_expired', 'session has expired');
    if (req.workspace !== this.projectId) {
      return new AepError('not_authorized', 'session is not bound to this workspace');
    }
    return s;
  }

  private permits(s: SessionRecord, action: ActionName): boolean {
    return (
      this.capabilities.has(ACTION_CAPABILITY[action]) &&
      ROLE_ACTIONS[s.role].has(action) &&
      (s.allowedActions === undefined || s.allowedActions.has(action))
    );
  }

  private checkAction(s: SessionRecord, req: CoreRequest): AepError | undefined {
    if (!Object.hasOwn(ACTIONS, req.action)) {
      return new AepError('unknown_action', `unknown action '${req.action}'`);
    }
    const action = req.action as ActionName;
    if (req.version !== ACTION_VERSION) {
      return new AepError(
        'unsupported_version',
        `action '${action}' supports version ${ACTION_VERSION} only`,
      );
    }
    if (!this.capabilities.has(ACTION_CAPABILITY[action])) {
      return new AepError(
        'capability_unsupported',
        `host does not declare capability '${ACTION_CAPABILITY[action]}'`,
      );
    }
    if (!this.permits(s, action)) {
      return new AepError('not_authorized', `action '${action}' is not permitted for this session`);
    }
    if (Buffer.byteLength(JSON.stringify(req)) > this.limits.maxRequestBytes) {
      return new AepError(
        'limit_exceeded',
        `request exceeds maxRequestBytes (${this.limits.maxRequestBytes})`,
      );
    }
    return undefined;
  }

  private async run(session: SessionRecord, req: CoreRequest): Promise<Outcome> {
    const action = req.action as ActionName;
    const def = ACTIONS[action];

    // 6. params
    const p = (def.params as Parseable).safeParse(req.params);
    if (!p.success) {
      const diagnostics = p.error.issues.slice(0, MAX_DIAGNOSTICS).map((i): Diagnostic => ({
        code: 'invalid_params',
        message: clampMessage(i.message),
        path: jsonPath(i.path),
      }));
      const first = diagnostics[0];
      throw new AepError(
        'invalid_params',
        `invalid params${first ? ` at ${first.path}: ${first.message}` : ''}`,
        diagnostics,
      );
    }

    // 7. base revision
    if (def.effect === 'write' && !NO_BASE_REVISION_ACTIONS.has(action)) {
      if (req.baseRevision === undefined) {
        throw new AepError('invalid_params', `action '${action}' requires baseRevision`, [
          { code: 'invalid_params', message: 'baseRevision is required', path: '/baseRevision' },
        ]);
      }
      if (req.baseRevision !== this.current.revision) {
        throw new AepError(
          'conflict',
          `baseRevision '${req.baseRevision}' is stale; current revision is '${this.current.revision}'`,
        );
      }
    }

    // 8. execute
    const params = p.data as Record<string, unknown>;
    switch (action) {
      case 'aep.capabilities':
        return {
          output: this.capabilitiesOutput(session, params.versions as string[] | undefined),
        };
      case 'project.inspect':
        return {
          output: {
            revision: this.current.revision,
            project: structuredClone(this.current.project),
          },
        };
      case 'project.describe':
        return { output: this.describeProject() };
      case 'transaction.validate':
        return this.validateTransaction(session, params.transaction as Transaction);
      case 'transaction.commit':
        return this.commitTransaction(session, req, params.transaction as Transaction);
      case 'proposal.create':
        return this.createProposal(
          session,
          params as { transaction: Transaction; proposalId?: string },
        );
      case 'proposal.list':
        return this.listProposals(params.status as string[] | undefined);
      case 'proposal.get':
        return this.getProposal(params as { proposalId: string; includeState: boolean });
      case 'proposal.accept':
        return this.acceptProposal(session, req, params.proposalId as string);
      case 'proposal.reject':
        return this.rejectProposal(params.proposalId as string);
      case 'history.list':
        return this.listHistory(params.limit as number);
      case 'history.undo':
        return this.undo(session, req, params.transactionId as string | undefined);
      case 'history.redo':
        return this.redo(session, req);
      case 'receipt.get':
        return this.getReceipt(session, params.requestId as string);
      case 'asset.list':
        return {
          output: {
            assets: params.store
              ? this.assets.list()
              : structuredClone(this.current.project.assets),
          },
        };
      case 'asset.import':
        return this.importAsset(
          params as { path: string; root: string; mediaType?: string; assetId?: string },
        );
      case 'render.request':
        return this.requestRender(params as unknown as RenderRequestParams);
      case 'generation.request':
        return this.requestGeneration(params as unknown as GenerationRequestParams);
      case 'job.status': {
        const job = this.jobs.get(params.jobId as string);
        if (!job) throw new AepError('not_found', `job '${String(params.jobId)}' not found`);
        return { output: { job } };
      }
      case 'job.cancel':
        return { output: { job: this.jobs.cancel(params.jobId as string) }, irreversible: true };
      default: {
        const unreachable: never = action;
        throw new Error(`unhandled action ${String(unreachable)}`);
      }
    }
  }

  private toAepError(e: unknown, req: CoreRequest): AepError {
    if (isAepError(e) && e.code !== 'internal_error') return e;
    this.reportInternal(e, req);
    return new AepError('internal_error', GENERIC_INTERNAL, [
      { code: 'internal_error', message: GENERIC_INTERNAL },
    ]);
  }

  private diagnosticsOf(err: AepError): Diagnostic[] {
    return err.diagnostics.length > 0
      ? err.diagnostics
      : [{ code: err.code, message: err.message }];
  }

  /** Build a non-success result (`rejected` / `failed` / `indeterminate`). */
  private failure(
    ids: { session: string; workspace: string; id: string },
    err: AepError,
    revision: string | undefined,
  ): CoreResult {
    return {
      protocol: CORE_PROTOCOL,
      session: ids.session,
      workspace: ids.workspace,
      id: ids.id,
      status: err.status,
      ...(revision !== undefined ? { revision } : {}),
      error: err.toCoreError(),
    };
  }

  private finalize(req: CoreRequest, result: CoreResult, record: RequestRecord): CoreResult {
    let problem: unknown;
    if (this.assertResults) problem = this.assertValid(req.action as ActionName, result);
    if (problem !== undefined) {
      // Never leave the ledger entry pending; surface the bug loudly afterwards.
      const err = new AepError('internal_error', GENERIC_INTERNAL);
      const failed = this.failure(req, err, this.current.revision);
      this.store(req, failed, {
        action: req.action,
        status: 'failed',
        errorCode: err.code,
        diagnostics: [],
      });
      throw problem;
    }
    this.store(req, result, record);
    return structuredClone(result);
  }

  private recordsFor(session: string): Map<string, RequestRecord> {
    let m = this.records.get(session);
    if (!m) this.records.set(session, (m = new Map()));
    return m;
  }

  private store(req: CoreRequest, result: CoreResult, record: RequestRecord): void {
    this.markDirty();
    this.reservations.delete(reservationKey(req.session, req.id));
    this.ledger.complete(req.session, req.id, result);
    const perSession = this.recordsFor(req.session);
    perSession.set(req.id, record);
    while (perSession.size > this.retention) {
      const oldest = perSession.keys().next().value;
      if (oldest === undefined) break;
      perSession.delete(oldest);
    }
  }

  /** Dev assertion: result must be a valid CoreResult whose output matches the action schema. */
  private assertValid(action: ActionName, result: CoreResult): unknown {
    const core = CoreResult.safeParse(result);
    if (!core.success) {
      return new Error(`host produced an invalid CoreResult for ${action}: ${core.error.message}`);
    }
    if (result.status === 'succeeded') {
      const out = (ACTIONS[action].output as Parseable).safeParse(result.output);
      if (!out.success) {
        const i = out.error.issues[0];
        return new Error(
          `host produced an invalid ${action} output at ${i ? jsonPath(i.path) : '/'}: ${i?.message ?? ''}`,
        );
      }
    }
    return undefined;
  }

  private resolveSession(sessionId?: string): SessionRecord {
    if (sessionId === undefined) {
      if (this.sessions.size === 1) return [...this.sessions.values()][0]!;
      throw new AepError(
        'bad_request',
        'sessionId is required when the host has not exactly one session',
      );
    }
    const s = this.sessions.get(sessionId);
    if (!s) throw new AepError('not_authorized', 'unknown session');
    return s;
  }

  // ---------------------------------------------------------------- state and revisions

  private revisionId(): string {
    return `rev-${this.revisionCounter}`;
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  private defaultCapabilities(): string[] {
    const caps = new Set<string>([
      ...Object.values(ACTION_CAPABILITY),
      ...Object.values(OPERATION_CAPABILITY),
    ]);
    const has = (kind: JobExecutor['kind']): boolean => this.executors.some((e) => e.kind === kind);
    if (!has('render')) caps.delete('aep.render');
    if (!has('generation')) caps.delete('aep.generation');
    if (this.executors.length === 0) caps.delete('aep.jobs');
    if (this.importRoots.size === 0) caps.delete('aep.audio.assets.import');
    return [...caps];
  }

  /** Apply a transaction's operations to `base`, then check invariants. No scope check. */
  private applyTransaction(
    base: Snapshot,
    tx: Transaction,
  ): { project: ProjectT; entities: EntityMap } {
    if (tx.operations.length > this.limits.maxOperationsPerTransaction) {
      throw new AepError(
        'limit_exceeded',
        `transaction has ${tx.operations.length} operations; maxOperationsPerTransaction is ${this.limits.maxOperationsPerTransaction}`,
      );
    }
    const applied = applyOperations(base.project, tx.operations, this.applyCtx);
    this.assertInvariants(applied, 'validation_failed');
    const entities = flattenProject(applied);
    return { project: unflattenProject(entities), entities };
  }

  private assertInvariants(project: ProjectT, code: ErrorCode): void {
    const diags = validateInvariants(project, this.limits);
    if (diags.length > 0) {
      throw new AepError(code, `project invariants violated: ${diags[0]!.message}`, diags);
    }
  }

  /** Effective scope = every given scope, each enforced independently. */
  private assertScopes(
    base: Snapshot,
    after: ProjectT,
    changes: Change[],
    operations: Operation[],
    scopes: (ScopeT | undefined)[],
  ): void {
    const diags: Diagnostic[] = [];
    for (const scope of scopes) {
      if (scope)
        diags.push(...checkScope({ changes, operations, scope, before: base.project, after }));
    }
    if (diags.length > 0) {
      throw new AepError(
        'scope_violation',
        `edit is outside the permitted scope: ${diags[0]!.message}`,
        diags,
      );
    }
  }

  private evaluate(base: Snapshot, tx: Transaction, scopes: (ScopeT | undefined)[]): Evaluated {
    const { project, entities } = this.applyTransaction(base, tx);
    const changes = diffEntities(base.entities, entities);
    this.assertScopes(base, project, changes, tx.operations, scopes);
    return { project, entities, changes };
  }

  /** Atomic commit: build everything first, then swap state in one step. */
  private commit(
    session: SessionRecord,
    requestId: string,
    kind: Receipt['kind'],
    base: Snapshot,
    ev: Evaluated,
    meta: {
      operations: string[];
      label?: string;
      proposalId?: string;
      targetTransactionId?: string;
      target?: HistoryRecord;
    },
  ): Receipt {
    const revision = `rev-${this.revisionCounter + 1}`;
    const committedAt = this.nowIso();
    const client = { name: session.client, session: session.id };
    const { created, removed } = createdRemoved(ev.changes);
    const receipt: Receipt = {
      transactionId: requestId,
      kind,
      projectId: this.projectId,
      baseRevision: base.revision,
      revision,
      committedAt,
      client,
      ...(meta.label !== undefined ? { label: meta.label } : {}),
      operationCount: meta.operations.length,
      operations: meta.operations,
      changes: ev.changes,
      created,
      removed,
      undoable: true,
      ...(meta.proposalId !== undefined ? { proposalId: meta.proposalId } : {}),
      ...(meta.targetTransactionId !== undefined
        ? { targetTransactionId: meta.targetTransactionId }
        : {}),
    };
    const entry: HistoryEntry = {
      transactionId: requestId,
      kind,
      baseRevision: base.revision,
      revision,
      committedAt,
      client,
      ...(meta.label !== undefined ? { label: meta.label } : {}),
      undoable: true,
      ...(meta.targetTransactionId !== undefined
        ? { targetTransactionId: meta.targetTransactionId }
        : {}),
    };
    this.revisionCounter += 1;
    this.current = { project: ev.project, entities: ev.entities, revision };
    this.history.push({
      entry,
      changes: ev.changes,
      sessionId: session.id,
      ...(meta.target ? { target: meta.target } : {}),
    });
    return receipt;
  }

  // ---------------------------------------------------------------- read actions

  private capabilitiesOutput(
    session: SessionRecord,
    clientVersions?: string[],
  ): CapabilitiesOutput {
    const capabilities: CapabilitiesOutput['capabilities'] = {};
    for (const id of [...this.capabilities].sort()) {
      let options: Record<string, unknown> | undefined;
      if (id === 'aep.render') {
        options = {
          renderers: this.executors
            .filter((e) => e.kind === 'render')
            .map((e) => ({ id: e.id, ...e.describe() })),
        };
      } else if (id === 'aep.audio.assets.import') {
        options = { roots: [...this.importRoots.keys()], maxBytes: this.maxAssetBytes };
      }
      capabilities[id] = { version: PROTOCOL_VERSION, ...(options ? { options } : {}) };
    }
    const negotiated = negotiateVersion(
      clientVersions ?? SUPPORTED_PROTOCOL_VERSIONS,
      SUPPORTED_PROTOCOL_VERSIONS,
    );
    if (negotiated === null) {
      throw new AepError(
        'unsupported_version',
        `no common AEP protocol version; host supports ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`,
      );
    }
    return {
      aep: {
        protocolVersion: negotiated,
        supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        schemaVersion: SCHEMA_VERSION,
      },
      host: { ...this.hostInfo, durability: this.persistence ? 'durable' : 'volatile' },
      capabilities,
      operations: OPERATION_NAMES.filter((o) => this.capabilities.has(OPERATION_CAPABILITY[o])),
      trackKinds: [...TrackKind.options],
      deviceTypes: [],
      generators: this.executors
        .filter((e) => e.kind === 'generation')
        .map((e) => {
          const d = e.describe();
          return {
            id: e.id,
            ...(d.name !== undefined ? { name: d.name } : {}),
            outputs: d.outputs,
            parametersSchema: d.parametersSchema ?? { type: 'object' },
            deterministic: d.deterministic,
          };
        }),
      limits: { ...this.limits },
      session: {
        role: session.role,
        ...(session.scope ? { scope: structuredClone(session.scope) } : {}),
        expiresAt: session.expiresAt,
      },
    };
  }

  private describeProject(): unknown {
    const p = this.current.project;
    let clipCount = 0;
    let noteCount = 0;
    let durationSeconds = 0;
    let durationBeats = 0;
    for (const t of p.tracks) {
      for (const c of t.clips) {
        clipCount += 1;
        if (c.type === 'midi') noteCount += c.notes.length;
        const end = c.start + c.duration;
        const seconds = c.timebase === 'seconds' ? end : beatsToSeconds(end, p.tempo);
        const beats = c.timebase === 'beats' ? end : secondsToBeats(end, p.tempo);
        durationSeconds = Math.max(durationSeconds, seconds);
        durationBeats = Math.max(durationBeats, beats);
      }
    }
    return {
      projectId: p.id,
      name: p.name,
      revision: this.current.revision,
      ...(p.sampleRate !== undefined ? { sampleRate: p.sampleRate } : {}),
      trackCount: p.tracks.length,
      clipCount,
      noteCount,
      assetCount: p.assets.length,
      durationSeconds,
      durationBeats,
      tempo: structuredClone(p.tempo),
      meter: structuredClone(p.meter),
    };
  }

  private validateTransaction(session: SessionRecord, tx: Transaction): Outcome {
    const base = this.current;
    try {
      const ev = this.evaluate(base, tx, [session.scope, tx.scope]);
      return {
        output: { valid: true, baseRevision: base.revision, diagnostics: [], changes: ev.changes },
      };
    } catch (e) {
      if (!isAepError(e) || e.code === 'internal_error') throw e;
      const diagnostics = clampDiagnostics(this.diagnosticsOf(e));
      return {
        output: { valid: false, baseRevision: base.revision, diagnostics, changes: [] },
        diagnostics,
      };
    }
  }

  private getReceipt(session: SessionRecord, requestId: string): Outcome {
    const rec = this.records.get(session.id)?.get(requestId);
    if (!rec) throw new AepError('not_found', `no retained record for request '${requestId}'`);
    return {
      output: {
        requestId,
        action: rec.action,
        status: rec.status,
        ...(rec.errorCode !== undefined ? { errorCode: rec.errorCode } : {}),
        diagnostics: rec.diagnostics,
        ...(rec.receipt ? { receipt: rec.receipt } : {}),
      },
    };
  }

  // ---------------------------------------------------------------- transactions

  private commitTransaction(session: SessionRecord, req: CoreRequest, tx: Transaction): Outcome {
    const base = this.current;
    const ev = this.evaluate(base, tx, [session.scope, tx.scope]);
    const receipt = this.commit(session, req.id, 'commit', base, ev, {
      operations: tx.operations.map((o) => o.op),
      ...(tx.label !== undefined ? { label: tx.label } : {}),
    });
    return receiptOutcome(receipt);
  }

  // ---------------------------------------------------------------- proposals (design §7)

  private openProposalCount(): number {
    let n = 0;
    for (const r of this.proposals.values()) if (r.proposal.status === 'open') n += 1;
    return n;
  }

  private createProposal(
    session: SessionRecord,
    params: { transaction: Transaction; proposalId?: string },
  ): Outcome {
    const tx = params.transaction;
    const id = params.proposalId ?? generateId('prop');
    if (this.proposals.has(id)) {
      throw new AepError('precondition_failed', `proposal '${id}' already exists`);
    }
    if (this.openProposalCount() >= this.limits.maxOpenProposals) {
      throw new AepError(
        'limit_exceeded',
        `maxOpenProposals (${this.limits.maxOpenProposals}) reached`,
      );
    }
    const base = this.current;
    const ev = this.evaluate(base, tx, [session.scope, tx.scope]);
    const proposal: Proposal = {
      id,
      status: 'open',
      baseRevision: base.revision,
      createdAt: this.nowIso(),
      client: { name: session.client, session: session.id },
      ...(tx.label !== undefined ? { label: tx.label } : {}),
      ...(tx.scope ? { scope: tx.scope } : {}),
      operations: tx.operations,
      changes: ev.changes,
    };
    this.proposals.set(id, {
      proposal,
      proposed: ev.project,
      ...(session.scope ? { proposerScope: session.scope } : {}),
    });
    return { output: structuredClone(proposal) };
  }

  private requireProposal(id: string): ProposalRecord {
    const rec = this.proposals.get(id);
    if (!rec) throw new AepError('not_found', `proposal '${id}' not found`);
    return rec;
  }

  private listProposals(status: string[] | undefined): Outcome {
    const list = [...this.proposals.values()]
      .map((r) => r.proposal)
      .filter((p) => !status || status.includes(p.status));
    return { output: { proposals: structuredClone(list) } };
  }

  private getProposal(params: { proposalId: string; includeState: boolean }): Outcome {
    const rec = this.requireProposal(params.proposalId);
    return {
      output: {
        proposal: structuredClone(rec.proposal),
        ...(params.includeState && rec.proposed ? { state: structuredClone(rec.proposed) } : {}),
      },
    };
  }

  private closeProposal(
    rec: ProposalRecord,
    status: Proposal['status'],
    acceptedRevision?: string,
  ): void {
    rec.proposal = {
      ...rec.proposal,
      status,
      ...(acceptedRevision !== undefined ? { acceptedRevision } : {}),
    };
    delete rec.proposed;
  }

  private acceptProposal(session: SessionRecord, req: CoreRequest, proposalId: string): Outcome {
    const rec = this.requireProposal(proposalId);
    const { proposal } = rec;
    if (proposal.status === 'stale') {
      throw new AepError('proposal_stale', `proposal '${proposalId}' is stale`);
    }
    if (proposal.status !== 'open' || !rec.proposed) {
      throw new AepError('proposal_closed', `proposal '${proposalId}' is ${proposal.status}`);
    }
    const base = this.current;
    const markStale = (e: AepError): never => {
      this.closeProposal(rec, 'stale');
      throw new AepError(
        'proposal_stale',
        `proposal '${proposalId}' no longer applies cleanly: ${e.message}`,
        e.diagnostics,
      );
    };

    let project = rec.proposed;
    let entities: EntityMap;
    if (base.revision === proposal.baseRevision) {
      entities = flattenProject(project);
    } else {
      try {
        entities = applyChanges(base.entities, proposal.changes);
        project = unflattenProject(entities);
      } catch (e) {
        return markStale(isAepError(e) ? e : new AepError('undo_conflict', 'changes do not apply'));
      }
      try {
        this.assertInvariants(project, 'validation_failed');
      } catch (e) {
        return markStale(
          isAepError(e) ? e : new AepError('validation_failed', 'invariants violated'),
        );
      }
    }
    const changes = diffEntities(base.entities, entities);
    this.assertScopes(base, project, changes, proposal.operations, [
      session.scope,
      proposal.scope,
      rec.proposerScope,
    ]);
    const receipt = this.commit(
      session,
      req.id,
      'proposal',
      base,
      { project, entities, changes },
      {
        operations: proposal.operations.map((o) => o.op),
        ...(proposal.label !== undefined ? { label: proposal.label } : {}),
        proposalId,
      },
    );
    this.closeProposal(rec, 'accepted', receipt.revision);
    return receiptOutcome(receipt);
  }

  private rejectProposal(proposalId: string): Outcome {
    const rec = this.requireProposal(proposalId);
    if (rec.proposal.status === 'accepted' || rec.proposal.status === 'rejected') {
      throw new AepError('proposal_closed', `proposal '${proposalId}' is ${rec.proposal.status}`);
    }
    this.closeProposal(rec, 'rejected');
    return { output: structuredClone(rec.proposal) };
  }

  // ---------------------------------------------------------------- history (design §8)

  /**
   * History record for a client-supplied transaction id. Ids are request ids, unique only per
   * session (and only while retained), so the latest match from the calling session wins; a
   * match from other sessions must be unambiguous.
   */
  private findHistoryById(
    session: SessionRecord,
    transactionId: string,
  ): HistoryRecord | undefined {
    const matches = this.history.filter((h) => h.entry.transactionId === transactionId);
    const own = matches.filter((h) => h.sessionId === session.id);
    if (own.length > 0) return own[own.length - 1];
    if (matches.length > 1) {
      throw new AepError(
        'precondition_failed',
        `transaction id '${transactionId}' is ambiguous: several sessions used it`,
      );
    }
    return matches[0];
  }

  private findUndoTarget(): HistoryRecord | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i]!;
      if (h.entry.kind !== 'undo' && h.entry.undoable && h.entry.undoneBy === undefined) return h;
    }
    return undefined;
  }

  /** The most recent undo that has not been redone, unless a later commit cleared the redo stack. */
  private findRedoTarget(): HistoryRecord | undefined {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const h = this.history[i]!;
      if (h.entry.kind === 'commit' || h.entry.kind === 'proposal') return undefined;
      if (h.entry.kind === 'undo' && h.entry.undoneBy === undefined) return h;
    }
    return undefined;
  }

  private listHistory(limit: number): Outcome {
    return {
      output: {
        entries: structuredClone(this.history.slice(-limit).map((h) => h.entry)),
        canUndo: this.findUndoTarget() !== undefined,
        canRedo: this.findRedoTarget() !== undefined,
      },
    };
  }

  /** Apply `changes` to the current state as a new commit, or fail with `undo_conflict`. */
  private applyHistoryChanges(
    session: SessionRecord,
    req: CoreRequest,
    kind: 'undo' | 'redo',
    changes: Change[],
    target: HistoryRecord,
  ): Receipt {
    const targetTransactionId = target.entry.transactionId;
    const base = this.current;
    let entities: EntityMap;
    let project: ProjectT;
    try {
      entities = applyChanges(base.entities, changes);
      project = unflattenProject(entities);
    } catch (e) {
      throw new AepError(
        'undo_conflict',
        `cannot ${kind} '${targetTransactionId}': ${isAepError(e) ? e.message : 'state no longer matches'}`,
      );
    }
    this.assertInvariants(project, 'undo_conflict');
    const diff = diffEntities(base.entities, entities);
    this.assertScopes(base, project, diff, [], [session.scope]);
    return this.commit(
      session,
      req.id,
      kind,
      base,
      { project, entities, changes: diff },
      {
        operations: [],
        targetTransactionId,
        target,
      },
    );
  }

  private undo(
    session: SessionRecord,
    req: CoreRequest,
    transactionId: string | undefined,
  ): Outcome {
    let target: HistoryRecord | undefined;
    if (transactionId !== undefined) {
      target = this.findHistoryById(session, transactionId);
      if (!target)
        throw new AepError('not_found', `transaction '${transactionId}' not found in history`);
      if (target.entry.kind === 'undo' || !target.entry.undoable) {
        throw new AepError(
          'precondition_failed',
          `transaction '${transactionId}' cannot be undone (use history.redo to revert an undo)`,
        );
      }
      if (target.entry.undoneBy !== undefined) {
        throw new AepError(
          'precondition_failed',
          `transaction '${transactionId}' was already undone`,
        );
      }
    } else {
      target = this.findUndoTarget();
      if (!target) throw new AepError('nothing_to_undo', 'there is nothing to undo');
    }
    const receipt = this.applyHistoryChanges(
      session,
      req,
      'undo',
      invertChanges(target.changes),
      target,
    );
    target.entry.undoneBy = req.id;
    return receiptOutcome(receipt);
  }

  private redo(session: SessionRecord, req: CoreRequest): Outcome {
    const undoRec = this.findRedoTarget();
    if (!undoRec) throw new AepError('nothing_to_redo', 'there is nothing to redo');
    const target = undoRec.target;
    if (!target)
      throw new AepError('nothing_to_redo', 'the undone transaction is no longer in history');
    const receipt = this.applyHistoryChanges(session, req, 'redo', target.changes, target);
    undoRec.entry.undoneBy = req.id;
    return receiptOutcome(receipt);
  }

  // ---------------------------------------------------------------- assets (design §9)

  private async importAsset(params: {
    path: string;
    root: string;
    mediaType?: string;
    assetId?: string;
  }): Promise<Outcome> {
    const rootDir = this.importRoots.get(params.root);
    if (rootDir === undefined) {
      throw new AepError('path_rejected', `unknown import root '${params.root}'`);
    }
    const resolve = async (): Promise<string> => {
      try {
        return await resolveInsideRoot(rootDir, params.path);
      } catch (e) {
        // Core messages may embed the configured root; clients never see host paths.
        if (isAepError(e)) throw new AepError(e.code, e.message.split(rootDir).join('<root>'));
        throw e;
      }
    };
    await resolve(); // confinement: traversal or a symlink escape is path_rejected
    const name = params.path.slice(params.path.lastIndexOf('/') + 1);
    const mediaType = params.mediaType ?? mediaTypeFromName(name);
    if (mediaType === undefined || !IMPORTABLE_MEDIA_TYPES.has(mediaType)) {
      const path = params.mediaType === undefined ? '/path' : '/mediaType';
      throw new AepError(
        'invalid_params',
        mediaType === undefined
          ? 'cannot infer a supported mediaType from the file name; pass mediaType'
          : `unsupported mediaType '${mediaType}'`,
        [{ code: 'invalid_params', message: 'unsupported or unknown media type', path }],
      );
    }
    const tooLarge = (): never => {
      throw new AepError(
        'limit_exceeded',
        `file exceeds the import limit of ${this.maxAssetBytes} bytes`,
      );
    };
    // Open the requested path itself without following its final component (§14: a symlink leaf
    // is `path_rejected`; symlinked directories are fine once confined), then confirm the opened
    // inode is the file the root-confined path resolves to. This also closes the window in which
    // the tree could be swapped between the confinement check and the open.
    let handle: FileHandle;
    try {
      handle = await open(
        join(rootDir, params.path),
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new AepError(
          'asset_not_found',
          `no file at '${params.path}' in root '${params.root}'`,
        );
      }
      if (code === 'ELOOP') {
        throw new AepError('path_rejected', 'the final path component is a symbolic link');
      }
      throw e;
    }
    let bytes: Buffer;
    try {
      const st = await handle.stat();
      if (!st.isFile()) throw new AepError('path_rejected', 'path is not a regular file');
      const again = await stat(await resolve()).catch(() => undefined);
      if (again?.dev !== st.dev || again.ino !== st.ino) {
        throw new AepError('path_rejected', 'path changed during import');
      }
      if (st.size > this.maxAssetBytes) tooLarge();
      // Read at most one byte past the stat size, so a file that grows meanwhile is caught.
      const buf = Buffer.alloc(st.size + 1);
      let total = 0;
      while (total < buf.length) {
        const { bytesRead } = await handle.read(buf, total, buf.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > st.size) throw new AepError('path_rejected', 'file changed during import');
      bytes = buf.subarray(0, total);
    } finally {
      await handle.close();
    }
    if (params.assetId !== undefined && this.assets.has(params.assetId)) {
      throw new AepError(
        'precondition_failed',
        `asset '${params.assetId}' already exists in the store`,
      );
    }
    const asset = this.assets.put(bytes, {
      ...(params.assetId !== undefined ? { id: params.assetId } : {}),
      name,
      mediaType,
    });
    return { output: { asset }, undo: () => this.assets.delete(asset.id) };
  }

  // ---------------------------------------------------------------- jobs (design §10)

  private snapshotFor(proposalId: string | undefined): { project: ProjectT; revision: string } {
    if (proposalId === undefined)
      return { project: this.current.project, revision: this.current.revision };
    const rec = this.requireProposal(proposalId);
    if (rec.proposal.status === 'stale') {
      throw new AepError('proposal_stale', `proposal '${proposalId}' is stale`);
    }
    if (rec.proposal.status !== 'open' || !rec.proposed) {
      throw new AepError('proposal_closed', `proposal '${proposalId}' is ${rec.proposal.status}`);
    }
    return { project: rec.proposed, revision: this.current.revision };
  }

  private startJob(
    executor: JobExecutor,
    input: JobInput,
    request: Record<string, unknown>,
  ): Outcome {
    const problems = executor.validate?.(input) ?? [];
    if (problems.length > 0) {
      // Executor messages may carry host paths or internals (SPECIFICATION §14): pass only the
      // code and the parameter path through, like job errors.
      const safe = problems.slice(0, MAX_DIAGNOSTICS).map((p): Diagnostic => ({
        code: p.code,
        message: `invalid ${input.kind} parameter${p.path ? ` at ${p.path}` : ''}`,
        ...(p.path !== undefined ? { path: p.path } : {}),
      }));
      throw new AepError('invalid_params', `invalid ${input.kind} parameters`, safe);
    }
    const job = this.jobs.create({ executor, input, request });
    return {
      output: { job },
      undo: () => this.jobs.discard(job.id),
      afterCommit: () => this.jobs.start(job.id),
    };
  }

  private requestRender(params: RenderRequestParams): Outcome {
    const executor = this.executors.find((e) => e.kind === 'render');
    if (!executor) throw new AepError('capability_unsupported', 'no render executor is registered');
    const snap = this.snapshotFor(params.proposalId);
    for (const id of params.trackIds ?? []) {
      if (!snap.project.tracks.some((t) => t.id === id)) {
        throw new AepError('not_found', `track '${id}' not found`, [
          { code: 'not_found', message: `track '${id}' not found`, path: '/trackIds' },
        ]);
      }
    }
    return this.startJob(
      executor,
      {
        kind: 'render',
        params,
        project: snap.project,
        revision: snap.revision,
        ...(params.proposalId !== undefined ? { proposalId: params.proposalId } : {}),
      },
      params as unknown as Record<string, unknown>,
    );
  }

  private requestGeneration(params: GenerationRequestParams): Outcome {
    const executor = this.executors.find(
      (e) => e.kind === 'generation' && e.id === params.generator,
    );
    if (!executor) {
      throw new AepError('not_found', `generator '${params.generator}' is not available`, [
        { code: 'not_found', message: 'unknown generator', path: '/generator' },
      ]);
    }
    const snap = this.snapshotFor(undefined);
    return this.startJob(
      executor,
      { kind: 'generation', params, project: snap.project, revision: snap.revision },
      params as unknown as Record<string, unknown>,
    );
  }
}
