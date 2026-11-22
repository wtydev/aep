import { constants as fsConstants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
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
} from '@aep/core';
import type { EntityMap } from '@aep/core';
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
} from '@aep/schema';
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
} from '@aep/schema';
import type { Project as ProjectT, Scope as ScopeT } from '@aep/schema';
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
import type { RequestHandler } from './request-handler.js';
import { JobManager } from './jobs.js';
import type { JobExecutor, JobInput } from './jobs.js';

export const DEFAULT_LIMITS: Limits = {
  maxOperationsPerTransaction: 1000,
  maxRequestBytes: 1_048_576,
  maxNotesPerClip: 100_000,
  maxTracks: 512,
  maxOpenProposals: 64,
  receiptRetention: 1000,
};

export const DEFAULT_HOST_INFO = { name: 'aep-reference-host', version: '0.1.0' } as const;
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTICS = 200;
const ABSENT_CREDENTIAL_HASH = sha256Hex('');
const GENERIC_INTERNAL = 'internal error while processing the request';

type Role = 'read' | 'propose' | 'edit' | 'admin';

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

const jsonPath = (path: readonly PropertyKey[]): string =>
  path.length === 0
    ? '/'
    : '/' + path.map((p) => String(p).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');

/**
 * Reference AEP host engine: sessions, transactions, proposals, history, assets and jobs over
 * one in-memory project. Implements the host side of MEP Core 1 (`RequestHandler`). Every
 * commit is a single reference swap, so a request that fails can never leave partial state.
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

  private readonly sessions = new Map<string, SessionRecord>();
  private readonly ledger: RequestLedger;
  private readonly records = new Map<string, Map<string, RequestRecord>>();
  private readonly assets = new AssetStore();
  private readonly jobs: JobManager;
  private readonly proposals = new Map<string, ProposalRecord>();
  private readonly history: HistoryRecord[] = [];
  private readonly applyCtx: ApplyContext;

  private current: Snapshot;
  private revisionCounter = 0;

  constructor(options: AepHostOptions) {
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
    this.jobs = new JobManager({ assets: this.assets, clock: this.clock });

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

  // ---------------------------------------------------------------- public surface

  get projectId(): string {
    return this.current.project.id;
  }

  get revision(): string {
    return this.current.revision;
  }

  /** Out-of-band session creation (design §6). The credential is returned exactly once. */
  createSession(opts: CreateSessionOptions): SessionGrant {
    if (opts.client.length === 0 || opts.client.length > 128) {
      throw new RangeError('client name must be 1..128 characters');
    }
    const scope = opts.scope === undefined ? undefined : Scope.parse(opts.scope);
    for (const a of opts.allowedActions ?? []) {
      if (!Object.hasOwn(ACTIONS, a))
        throw new RangeError(`unknown action '${a}' in allowedActions`);
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
    return { session: id, credential, workspace: this.projectId };
  }

  revokeSession(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) throw new AepError('not_authorized', 'unknown session');
    s.revoked = true;
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
      revision: this.current.revision,
      data: structuredClone(this.current.project),
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
  waitForJobs(): Promise<void> {
    return this.jobs.idle();
  }

  // ---------------------------------------------------------------- request pipeline (design §1)

  async handle(raw: unknown): Promise<CoreResult> {
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
        new AepError('bad_request', `request is not a valid MEP Core 1 request${where}`),
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
    if (begin.kind === 'replay') return structuredClone(begin.result);
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

    // 6-8. params, base revision, execute
    let result: CoreResult;
    let record: RequestRecord;
    try {
      const outcome = await this.run(session, req);
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

    // 9. store
    return this.finalize(req, result, record);
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
        return { output: { job: this.jobs.cancel(params.jobId as string) } };
      default: {
        const unreachable: never = action;
        throw new Error(`unhandled action ${String(unreachable)}`);
      }
    }
  }

  private toAepError(e: unknown, req: CoreRequest): AepError {
    if (isAepError(e) && e.code !== 'internal_error') return e;
    try {
      this.onInternalError?.(e, { action: req.action, id: req.id });
    } catch {
      // a faulty logging hook must not change the outcome
    }
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

  private store(req: CoreRequest, result: CoreResult, record: RequestRecord): void {
    this.ledger.complete(req.session, req.id, result);
    let perSession = this.records.get(req.session);
    if (!perSession) {
      perSession = new Map();
      this.records.set(req.session, perSession);
    }
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
      host: { ...this.hostInfo },
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
    const real = await resolve();
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
    // Open without following a final symlink, then confirm the opened inode is still the file
    // the root-confined path resolves to. This closes the window in which the tree could be
    // swapped between the confinement check and the open.
    let handle: FileHandle;
    try {
      handle = await open(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new AepError(
          'asset_not_found',
          `no file at '${params.path}' in root '${params.root}'`,
        );
      }
      if (code === 'ELOOP') throw new AepError('path_rejected', 'path changed during import');
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
    return { output: { asset } };
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
      throw new AepError(
        'invalid_params',
        `invalid ${input.kind} parameters: ${problems[0]!.message}`,
        problems,
      );
    }
    return { output: { job: this.jobs.create({ executor, input, request }) } };
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
