import { AepError, generateId, isAepError } from '@aep/core';
import { Operation } from '@aep/schema';
import type {
  Asset,
  Diagnostic,
  GenerationRequestParams,
  Job,
  Project,
  RenderRequestParams,
} from '@aep/schema';
import type { AssetMeta, AssetStore } from './assets.js';

/** What an executor declares about itself (surfaced through `aep.capabilities`). */
export interface ExecutorDescription {
  name?: string;
  outputs: ('audio' | 'midi' | 'operations')[];
  /** JSON Schema of the generator `parameters` (generation executors). */
  parametersSchema?: Record<string, unknown>;
  deterministic: boolean;
}

interface JobInputBase {
  /** Immutable snapshot of the project the job is bound to (accepted revision or proposal). */
  project: Project;
  revision: string;
  proposalId?: string;
}

export type JobInput =
  | (JobInputBase & { kind: 'render'; params: RenderRequestParams })
  | (JobInputBase & { kind: 'generation'; params: GenerationRequestParams });

export interface JobContext {
  /** Aborted when the job is cancelled. Executors SHOULD stop promptly. */
  signal: AbortSignal;
  /** Report progress in 0..1. */
  progress(fraction: number): void;
  /** Register bytes in the host asset store (outside project state until `asset.link`). */
  putAsset(bytes: Uint8Array, meta: AssetMeta): Asset;
}

export interface JobOutput {
  assets?: Asset[];
  /** Operations the client may submit as a transaction or proposal. */
  operations?: Operation[];
  reproducibility?: Record<string, unknown>;
}

/**
 * Pluggable renderer / generator. The host never executes project-supplied code: executors are
 * registered by the embedding application only.
 */
export interface JobExecutor {
  readonly kind: 'render' | 'generation';
  /** Renderer id, or the generator id used in `generation.request.generator`. */
  readonly id: string;
  describe(): ExecutorDescription;
  /** Optional synchronous request-time validation; returned diagnostics → `invalid_params`. */
  validate?(input: JobInput): Diagnostic[];
  run(input: JobInput, ctx: JobContext): Promise<JobOutput>;
}

interface JobRecord {
  job: Job;
  executor: JobExecutor;
  /** Project snapshot for the executor; released once the job settles. */
  input: JobInput | undefined;
  controller: AbortController;
  /** Resolves when the job is terminal: on cancel, or when `run` settles. */
  done: Promise<void>;
  settle: () => void;
}

export interface JobCreate {
  executor: JobExecutor;
  input: JobInput;
  request: Record<string, unknown>;
}

const TERMINAL: ReadonlySet<Job['state']> = new Set(['succeeded', 'failed', 'cancelled']);

/** Asynchronous, cancellable job runner (design §10). Jobs never touch project state. */
export class JobManager {
  private readonly jobs = new Map<string, JobRecord>();

  constructor(private readonly deps: { assets: AssetStore; clock: () => number }) {}

  private now(): string {
    return new Date(this.deps.clock()).toISOString();
  }

  create(spec: JobCreate): Job {
    const id = generateId('job');
    const now = this.now();
    const job: Job = {
      id,
      kind: spec.executor.kind,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      revision: spec.input.revision,
      ...(spec.input.proposalId !== undefined ? { proposalId: spec.input.proposalId } : {}),
      request: structuredClone(spec.request),
    };
    const rec: JobRecord = {
      job,
      executor: spec.executor,
      input: spec.input,
      controller: new AbortController(),
      done: Promise.resolve(),
      settle: () => {},
    };
    rec.done = new Promise<void>((resolve) => {
      rec.settle = resolve;
    });
    setImmediate(() => {
      void this.run(rec).finally(() => {
        rec.input = undefined;
        rec.settle();
      });
    });
    this.jobs.set(id, rec);
    return structuredClone(job);
  }

  get(id: string): Job | undefined {
    const rec = this.jobs.get(id);
    return rec ? structuredClone(rec.job) : undefined;
  }

  /** queued/running → cancelled. Throws `not_found` / `job_not_cancellable`. */
  cancel(id: string): Job {
    const rec = this.jobs.get(id);
    if (!rec) throw new AepError('not_found', `job '${id}' not found`);
    if (TERMINAL.has(rec.job.state)) {
      throw new AepError('job_not_cancellable', `job '${id}' is already ${rec.job.state}`);
    }
    rec.job.state = 'cancelled';
    rec.job.updatedAt = this.now();
    rec.controller.abort();
    // Cancelled is terminal now; `idle()` must not wait on an executor that ignores the signal.
    rec.settle();
    return structuredClone(rec.job);
  }

  /** Resolves when every job created so far has reached a terminal state. */
  async idle(): Promise<void> {
    await Promise.all([...this.jobs.values()].map((r) => r.done));
  }

  private async run(rec: JobRecord): Promise<void> {
    const { job, executor, controller, input } = rec;
    if (job.state !== 'queued' || !input) return; // cancelled before it started
    job.state = 'running';
    job.updatedAt = this.now();
    const produced: Asset[] = [];
    const ctx: JobContext = {
      signal: controller.signal,
      progress: (fraction) => {
        if (controller.signal.aborted || job.state !== 'running') return;
        job.progress = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
        job.updatedAt = this.now();
      },
      putAsset: (bytes, meta) => {
        if (controller.signal.aborted) throw new Error('job was cancelled');
        const asset = this.deps.assets.put(bytes, meta);
        produced.push(asset);
        return asset;
      },
    };
    try {
      const out = await executor.run(structuredClone(input), ctx);
      if (controller.signal.aborted) return;
      const operations = out.operations ? Operation.array().parse(out.operations) : undefined;
      job.state = 'succeeded';
      job.progress = 1;
      job.result = {
        assets: [...(out.assets ?? produced)],
        ...(operations ? { operations } : {}),
        reproducibility: { executor: executor.id, ...out.reproducibility },
      };
    } catch (e) {
      if (controller.signal.aborted) return;
      job.state = 'failed';
      // Only the code is passed through: executor messages may carry host paths or internals.
      job.error = isAepError(e)
        ? { code: e.code, message: `job executor failed (${e.code})` }
        : { code: 'internal_error', message: 'job executor failed' };
    }
    job.updatedAt = this.now();
  }
}
