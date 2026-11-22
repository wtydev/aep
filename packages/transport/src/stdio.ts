import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptionsWithoutStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { CoreManifest, CoreResult, CoreState, sanitizeRequestId } from '@aep/schema';
import type { CoreRequest } from '@aep/schema';
import { badRequestResult, internalErrorResult } from './results.js';
import type { ClientTransport, RequestHandler } from './types.js';

const MAX_LINE_BYTES = 4 * 1024 * 1024;

export interface ServeStdioOptions {
  handler: RequestHandler;
  input: Readable;
  output: Writable;
}

const extractId = (msg: unknown): string =>
  sanitizeRequestId(
    typeof msg === 'object' && msg !== null ? (msg as { id?: unknown }).id : undefined,
  );

const isMeta = (msg: unknown): msg is { type: 'state' | 'manifest' } => {
  if (typeof msg !== 'object' || msg === null || 'protocol' in msg) return false;
  const type = (msg as { type?: unknown }).type;
  return type === 'state' || type === 'manifest';
};

/**
 * NDJSON stdio binding, host side.
 *
 * On startup the host writes one `{"type":"hello","manifest":CoreManifest}` line. Afterwards,
 * for each client→host line:
 *
 *  - a CoreRequest object  → handled concurrently; answered with
 *    `{"type":"result","result":CoreResult}`; results may arrive out of order and are
 *    matched by `id`
 *  - `{"type":"state"}`    → answered with `{"type":"state","state":CoreState}`
 *  - `{"type":"manifest"}` → answered with `{"type":"manifest","manifest":CoreManifest}`
 *
 * Malformed JSON lines and lines longer than 4 MiB get a `bad_request` result with id
 * `"invalid"`. EOF on `input` shuts the binding down: the returned promise resolves once all
 * in-flight requests have completed.
 */
export async function serveStdio({ handler, input, output }: ServeStdioOptions): Promise<void> {
  const manifest = handler.manifest();

  let writeChain: Promise<void> = Promise.resolve();
  const writeLine = (obj: unknown): Promise<void> => {
    writeChain = writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          output.write(JSON.stringify(obj) + '\n', (err) => (err ? reject(err) : resolve()));
        }),
    );
    return writeChain;
  };

  const badRequest = (id: string, message: string): Promise<void> =>
    writeLine({ type: 'result', result: badRequestResult(manifest, id, message) });

  await writeLine({ type: 'hello', manifest });

  const inflight = new Set<Promise<void>>();

  const processLine = (line: string): void => {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) {
      void badRequest('invalid', `line exceeds ${MAX_LINE_BYTES} bytes`);
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      void badRequest('invalid', 'malformed JSON line');
      return;
    }
    if (isMeta(msg)) {
      void writeLine(
        msg.type === 'state'
          ? { type: 'state', state: handler.state() }
          : { type: 'manifest', manifest: handler.manifest() },
      );
      return;
    }
    const p = Promise.resolve()
      .then(() => handler.handle(msg))
      .then((result) => writeLine({ type: 'result', result }))
      .catch(() =>
        writeLine({ type: 'result', result: internalErrorResult(manifest, extractId(msg)) }),
      )
      .finally(() => inflight.delete(p));
    inflight.add(p);
  };

  let buffer = '';
  let discarding = false;
  let resolveDone!: () => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  // A StringDecoder keeps a multi-byte UTF-8 sequence split across chunks intact.
  const decoder = new StringDecoder('utf8');
  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (;;) {
      const nl = buffer.indexOf('\n');
      if (nl < 0) break;
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (discarding) {
        discarding = false;
        continue;
      }
      if (line.endsWith('\r')) line = line.slice(0, -1);
      processLine(line);
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
      if (!discarding) void badRequest('invalid', `line exceeds ${MAX_LINE_BYTES} bytes`);
      buffer = '';
      discarding = true;
    }
  };

  const onEnd = (): void => {
    buffer += decoder.end();
    if (!discarding && buffer.trim().length > 0) processLine(buffer);
    void Promise.allSettled([...inflight])
      .then(() => writeChain)
      .then(resolveDone, rejectDone);
  };

  input.on('data', onData);
  input.once('end', onEnd);
  input.once('error', rejectDone);

  try {
    await done;
  } finally {
    input.off('data', onData);
    input.off('end', onEnd);
    input.off('error', rejectDone);
  }
}

interface Waiter<T> {
  resolve: (value: T) => void;
  reject: (e: unknown) => void;
}

/**
 * NDJSON stdio binding, client side. Results are matched to pending sends by `id` (requests
 * may be pipelined and may complete out of order); `state`/`manifest` replies are handed out
 * FIFO to `state()`/`manifest()` calls. `hello` resolves with the manifest from the host's
 * startup line.
 */
export class StdioClientTransport implements ClientTransport {
  private readonly input: Readable;
  private readonly output: Writable;
  private child: ChildProcess | undefined;
  private buffer = '';
  private readonly decoder = new StringDecoder('utf8');
  private closed = false;
  /** Why the connection is unusable (stream ended, errored, child exited), once it is. */
  private failure: Error | undefined;
  private readonly pending = new Map<string, Waiter<CoreResult>>();
  private readonly stateWaiters: Waiter<CoreState>[] = [];
  private readonly manifestWaiters: Waiter<CoreManifest>[] = [];
  /** Manifest from the host's initial `{"type":"hello"}` line. */
  readonly hello: Promise<CoreManifest>;
  private helloResolve!: (m: CoreManifest) => void;
  private helloReject!: (e: unknown) => void;
  /**
   * Timeout for `send`, `state()` and `manifest()`; a timed-out request can be retried with the
   * same id afterwards.
   */
  requestTimeoutMs = 120_000;

  constructor(input: Readable, output: Writable) {
    this.input = input;
    this.output = output;
    this.hello = new Promise((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
    });
    // `hello` may legitimately never be awaited; don't let its rejection go unhandled.
    this.hello.catch(() => {});
    input.on('data', this.onData);
    input.once('end', () => this.fail(new Error('transport stream ended')));
    input.once('error', (e) => this.fail(e));
    output.once('error', (e) => this.fail(e));
  }

  /** Spawn a host process (no shell) and bind to its stdin/stdout; stderr is inherited. */
  static spawn(
    command: string,
    args: string[] = [],
    opts?: SpawnOptionsWithoutStdio,
  ): StdioClientTransport {
    const child = spawn(command, args, { ...opts, stdio: ['pipe', 'pipe', 'inherit'] });
    const transport = new StdioClientTransport(child.stdout, child.stdin);
    transport.child = child;
    // e.g. ENOENT for a missing command; without a listener this would crash the process.
    child.once('error', (e) => transport.fail(e));
    child.once('exit', (code, signal) =>
      transport.fail(new Error(`host process exited (${signal ?? `code ${code}`})`)),
    );
    return transport;
  }

  private onData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl < 0) return;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      this.dispatch(line);
    }
  };

  private dispatch(line: string): void {
    let parsedLine: unknown;
    try {
      parsedLine = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof parsedLine !== 'object' || parsedLine === null) return;
    const msg = parsedLine as Record<string, unknown>;
    switch (msg.type) {
      case 'hello': {
        const parsed = CoreManifest.safeParse(msg.manifest);
        if (parsed.success) this.helloResolve(parsed.data);
        else this.helloReject(new Error('invalid hello manifest from host'));
        return;
      }
      case 'state': {
        const waiter = this.stateWaiters.shift();
        if (waiter) {
          const parsed = CoreState.safeParse(msg.state);
          if (parsed.success) waiter.resolve(parsed.data);
          else waiter.reject(new Error('invalid state document from host'));
        }
        return;
      }
      case 'manifest': {
        const waiter = this.manifestWaiters.shift();
        if (waiter) {
          const parsed = CoreManifest.safeParse(msg.manifest);
          if (parsed.success) waiter.resolve(parsed.data);
          else waiter.reject(new Error('invalid manifest document from host'));
        }
        return;
      }
      case 'result': {
        const parsed = CoreResult.safeParse(msg.result);
        if (!parsed.success) {
          // Fail the matching request instead of leaving it to hang.
          const result = msg.result;
          const rawId =
            typeof result === 'object' && result !== null
              ? (result as { id?: unknown }).id
              : undefined;
          const waiter = typeof rawId === 'string' ? this.pending.get(rawId) : undefined;
          const err = new Error('invalid result document from host');
          if (waiter && typeof rawId === 'string') {
            this.pending.delete(rawId);
            waiter.reject(err);
          } else {
            // The result cannot be attributed to any request: every pending request may be the
            // one it answered, so fail them all rather than let one hang until its timeout.
            for (const w of this.pending.values()) w.reject(err);
            this.pending.clear();
          }
          return;
        }
        const waiter = this.pending.get(parsed.data.id);
        if (waiter) {
          this.pending.delete(parsed.data.id);
          waiter.resolve(parsed.data);
        }
        return;
      }
      default:
    }
  }

  send(req: CoreRequest): Promise<CoreResult> {
    if (this.closed) return Promise.reject(this.failure ?? new Error('transport closed'));
    if (this.pending.has(req.id)) {
      return Promise.reject(new Error(`request id '${req.id}' is already in flight`));
    }
    return new Promise<CoreResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.get(req.id)?.reject === wrappedReject) {
          this.pending.delete(req.id);
          reject(new Error(`timed out after ${this.requestTimeoutMs} ms waiting for '${req.id}'`));
        }
      }, this.requestTimeoutMs);
      timer.unref?.();
      const wrappedReject = (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      };
      const wrappedResolve = (r: CoreResult) => {
        clearTimeout(timer);
        resolve(r);
      };
      this.pending.set(req.id, { resolve: wrappedResolve, reject: wrappedReject });
      this.output.write(JSON.stringify(req) + '\n', (err) => {
        if (err) {
          this.pending.delete(req.id);
          wrappedReject(err);
        }
      });
    });
  }

  manifest(): Promise<CoreManifest> {
    return this.meta('manifest', this.manifestWaiters);
  }

  state(): Promise<CoreState> {
    return this.meta('state', this.stateWaiters);
  }

  private meta<T>(type: 'manifest' | 'state', waiters: Waiter<T>[]): Promise<T> {
    if (this.closed) return Promise.reject(this.failure ?? new Error('transport closed'));
    return new Promise<T>((resolve, reject) => {
      // Replies are FIFO, so a timed-out waiter keeps its queue slot (a late reply still lands
      // on it, not on the next caller); it just no longer settles the caller's promise.
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`timed out after ${this.requestTimeoutMs} ms waiting for ${type}`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      const waiter: Waiter<T> = {
        resolve: (v) => {
          clearTimeout(timer);
          if (!settled) resolve(v);
          settled = true;
        },
        reject: (e) => {
          clearTimeout(timer);
          if (!settled) reject(e);
          settled = true;
        },
      };
      waiters.push(waiter);
      this.output.write(JSON.stringify({ type }) + '\n', (err) => {
        if (err) waiter.reject(err);
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.fail(new Error('transport closed'));
    this.output.end();
    this.child?.kill();
  }

  /** Mark the connection dead: settle `hello`, fail every waiter, and refuse later calls. */
  private fail(e: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = e instanceof Error ? e : new Error(String(e));
    this.helloReject(this.failure);
    this.failAll(this.failure);
  }

  private failAll(e: unknown): void {
    for (const waiter of this.pending.values()) waiter.reject(e);
    this.pending.clear();
    for (const waiter of this.stateWaiters) waiter.reject(e);
    for (const waiter of this.manifestWaiters) waiter.reject(e);
    this.stateWaiters.length = 0;
    this.manifestWaiters.length = 0;
  }
}
