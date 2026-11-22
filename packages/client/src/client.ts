import { AepError, generateId } from '@aep/core';
import { ACTIONS, ACTION_VERSION, CORE_PROTOCOL, NO_BASE_REVISION_ACTIONS } from '@aep/schema';
import type {
  ActionName,
  ActionOutput,
  ActionParams,
  CoreManifest,
  CoreRequest,
  CoreResult,
  Job,
  NextStep,
  Transaction,
} from '@aep/schema';
import type { ClientTransport } from '@aep/transport';

const newRequestId = (): string => generateId('req');

/** Thrown by {@link AepClient.call} for any non-`succeeded` result. */
export class AepRequestError extends Error {
  override readonly name = 'AepRequestError';

  constructor(
    readonly code: string,
    readonly next: NextStep,
    message: string,
    readonly result: CoreResult,
  ) {
    super(message);
  }
}

export interface AepClientOptions {
  transport: ClientTransport;
  session: string;
  workspace: string;
  credential: string;
  /**
   * How many times a request is resent after a transport error. The identical request
   * (same `id`) is resent — request ids are idempotency keys, so this is safe.
   */
  maxRetries?: number;
}

export interface ConnectOptions {
  transport: ClientTransport;
  credential: string;
  session?: string;
  workspace?: string;
  maxRetries?: number;
}

export interface RequestOptions {
  id?: string;
  baseRevision?: string;
}

const TERMINAL_JOB_STATES = new Set(['succeeded', 'failed', 'cancelled']);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Typed AEP client over any ClientTransport.
 *
 * `request` returns the raw CoreResult; `call` unwraps a succeeded result's output and throws
 * {@link AepRequestError} otherwise. `lastRevision` tracks `revision` from results and is sent
 * as `baseRevision` on write actions unless overridden. A result for a request whose
 * `baseRevision` is no longer `lastRevision` (an idempotent replay of an old request, or a reply
 * that arrived after a later write) does not update it.
 */
export class AepClient {
  readonly transport: ClientTransport;
  readonly session: string;
  readonly workspace: string;
  private readonly credential: string;
  private readonly maxRetries: number;
  /** Revision from the most recent result; default `baseRevision` for write actions. */
  lastRevision: string | undefined;
  /** Session manifest, populated by {@link AepClient.connect}. */
  manifest: CoreManifest | undefined;

  constructor(opts: AepClientOptions) {
    this.transport = opts.transport;
    this.session = opts.session;
    this.workspace = opts.workspace;
    this.credential = opts.credential;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  /** Read the session manifest, then create a client (session/workspace default from it). */
  static async connect(opts: ConnectOptions): Promise<AepClient> {
    const manifest = await opts.transport.manifest();
    const client = new AepClient({
      transport: opts.transport,
      credential: opts.credential,
      session: opts.session ?? manifest.session,
      workspace: opts.workspace ?? manifest.workspace,
      maxRetries: opts.maxRetries,
    });
    client.manifest = manifest;
    return client;
  }

  async request<A extends ActionName>(
    action: A,
    params: ActionParams<A>,
    opts?: RequestOptions,
  ): Promise<CoreResult> {
    const baseRevision = opts?.baseRevision ?? this.defaultBaseRevision(action);
    const req: CoreRequest = {
      protocol: CORE_PROTOCOL,
      session: this.session,
      workspace: this.workspace,
      id: opts?.id ?? newRequestId(),
      credential: this.credential,
      action,
      version: ACTION_VERSION,
      params: params as Record<string, unknown>,
    };
    if (baseRevision !== undefined) req.baseRevision = baseRevision;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this.transport.send(req);
        // A request built on a base other than the current `lastRevision` answers about an older
        // state: an idempotent replay returns its original (old) result verbatim, and an
        // out-of-order reply belongs to an earlier write. Neither may move `lastRevision` back.
        const current =
          req.baseRevision === undefined ||
          this.lastRevision === undefined ||
          req.baseRevision === this.lastRevision;
        if (result.revision !== undefined && current) this.lastRevision = result.revision;
        return result;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  }

  async call<A extends ActionName>(
    action: A,
    params: ActionParams<A>,
    opts?: RequestOptions,
  ): Promise<ActionOutput<A>> {
    const result = await this.request(action, params, opts);
    if (result.status === 'succeeded') return result.output as ActionOutput<A>;
    const error =
      result.error ?? new AepError('internal_error', 'result missing error').toCoreError();
    throw new AepRequestError(error.code, error.next, error.message, result);
  }

  capabilities(): Promise<ActionOutput<'aep.capabilities'>> {
    return this.call('aep.capabilities', {});
  }

  inspect(): Promise<ActionOutput<'project.inspect'>> {
    return this.call('project.inspect', {});
  }

  validate(transaction: Transaction): Promise<ActionOutput<'transaction.validate'>> {
    return this.call('transaction.validate', { transaction });
  }

  commit(
    transaction: Transaction,
    opts?: RequestOptions,
  ): Promise<ActionOutput<'transaction.commit'>> {
    return this.call('transaction.commit', { transaction }, opts);
  }

  propose(
    transaction: Transaction,
    opts?: RequestOptions,
  ): Promise<ActionOutput<'proposal.create'>> {
    return this.call('proposal.create', { transaction }, opts);
  }

  acceptProposal(
    proposalId: string,
    opts?: RequestOptions,
  ): Promise<ActionOutput<'proposal.accept'>> {
    return this.call('proposal.accept', { proposalId }, opts);
  }

  rejectProposal(proposalId: string): Promise<ActionOutput<'proposal.reject'>> {
    return this.call('proposal.reject', { proposalId });
  }

  undo(opts?: RequestOptions): Promise<ActionOutput<'history.undo'>> {
    return this.call('history.undo', {}, opts);
  }

  redo(opts?: RequestOptions): Promise<ActionOutput<'history.redo'>> {
    return this.call('history.redo', {}, opts);
  }

  history(limit?: number): Promise<ActionOutput<'history.list'>> {
    return this.call('history.list', limit === undefined ? {} : { limit });
  }

  receipt(requestId: string): Promise<ActionOutput<'receipt.get'>> {
    return this.call('receipt.get', { requestId });
  }

  renderRequest(
    params: ActionParams<'render.request'>,
    opts?: RequestOptions,
  ): Promise<ActionOutput<'render.request'>> {
    return this.call('render.request', params, opts);
  }

  jobStatus(jobId: string): Promise<ActionOutput<'job.status'>> {
    return this.call('job.status', { jobId });
  }

  /** Poll `job.status` until the job reaches a terminal state. */
  async waitForJob(jobId: string, opts?: { timeoutMs?: number; pollMs?: number }): Promise<Job> {
    const timeoutMs = opts?.timeoutMs ?? 60_000;
    const pollMs = opts?.pollMs ?? 250;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { job } = await this.jobStatus(jobId);
      if (TERMINAL_JOB_STATES.has(job.state)) return job;
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for job ${jobId} (state: ${job.state})`);
      }
      await sleep(pollMs);
    }
  }

  importAsset(params: ActionParams<'asset.import'>): Promise<ActionOutput<'asset.import'>> {
    return this.call('asset.import', params);
  }

  listAssets(store = false): Promise<ActionOutput<'asset.list'>> {
    return this.call('asset.list', { store });
  }

  close(): Promise<void> {
    return this.transport.close();
  }

  private defaultBaseRevision(action: ActionName): string | undefined {
    if (this.lastRevision === undefined) return undefined;
    if (ACTIONS[action].effect !== 'write') return undefined;
    if (NO_BASE_REVISION_ACTIONS.has(action)) return undefined;
    return this.lastRevision;
  }
}
