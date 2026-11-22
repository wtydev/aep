import { randomBytes } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { CoreManifest, CoreResult, CoreState } from '@aep/schema';
import type { CoreRequest } from '@aep/schema';
import { badRequestResult, internalErrorResult } from './results.js';
import type { ClientTransport, RequestHandler } from './types.js';

const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** Characters allowed in a result file name (a superset of the CoreRequest id charset). */
const FILE_SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Write `data` to `path` via a sibling `.<name>.tmp` file + rename, mode 0600. */
async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.tmp`);
  await writeFile(tmp, data, { mode: 0o600 });
  await rename(tmp, path);
}

export interface DirectoryHostBindingOptions {
  dir: string;
  handler: RequestHandler;
  pollMs?: number;
}

/**
 * MEP Core 1 directory binding, host side.
 *
 * Publishes `mep.json` (manifest) and `state.json` (CoreState) in `dir` (mode 0700), polls
 * `requests/*.json` and processes them serially in (mtime, name) order: each request file is
 * read (max 4 MiB), handed to the RequestHandler, answered in `results/<id>.json` via
 * tmp+rename (mode 0600), then deleted; `state.json` is republished after every request.
 * Unreadable or unparseable request files yield a `bad_request` result whose id is the file
 * name stem (when file-name safe) or `"invalid"`.
 */
export class DirectoryHostBinding {
  private readonly dir: string;
  private readonly handler: RequestHandler;
  private readonly pollMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private current: Promise<void> | undefined;

  constructor(opts: DirectoryHostBindingOptions) {
    this.dir = opts.dir;
    this.handler = opts.handler;
    this.pollMs = opts.pollMs ?? 50;
  }

  private get requestsDir(): string {
    return join(this.dir, 'requests');
  }

  private get resultsDir(): string {
    return join(this.dir, 'results');
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await mkdir(this.requestsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.resultsDir, { recursive: true, mode: 0o700 });
    await this.publish();
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.current;
  }

  /** Write `mep.json` and `state.json`, atomically, mode 0600. */
  async publish(): Promise<void> {
    await writeFileAtomic(
      join(this.dir, 'mep.json'),
      JSON.stringify(this.handler.manifest(), null, 2),
    );
    await writeFileAtomic(
      join(this.dir, 'state.json'),
      JSON.stringify(this.handler.state(), null, 2),
    );
  }

  private tick(): Promise<void> {
    // a failed pass must not kill polling or surface as an unhandled rejection
    this.current ??= this.processPending()
      .catch(() => {})
      .finally(() => {
        this.current = undefined;
      });
    return this.current;
  }

  private async processPending(): Promise<void> {
    const names = (await readdir(this.requestsDir).catch(() => [] as string[])).filter(
      (n) => n.endsWith('.json') && !n.startsWith('.'),
    );
    const entries: { name: string; mtimeMs: number }[] = [];
    for (const name of names) {
      const st = await stat(join(this.requestsDir, name)).catch(() => undefined);
      if (st?.isFile()) entries.push({ name, mtimeMs: st.mtimeMs });
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
    for (const entry of entries) await this.processOne(entry.name);
  }

  private async processOne(name: string): Promise<void> {
    const stem = name.slice(0, -'.json'.length);
    const filePath = join(this.requestsDir, name);
    const st = await stat(filePath).catch(() => undefined);
    if (!st?.isFile()) return;

    let parsed: unknown;
    let malformed: string | undefined;
    if (st.size > MAX_REQUEST_BYTES) {
      malformed = `request exceeds ${MAX_REQUEST_BYTES} bytes`;
    } else {
      try {
        parsed = JSON.parse(await readFile(filePath, 'utf8'));
      } catch {
        malformed = 'request is not valid JSON';
      }
    }

    let result: CoreResult;
    if (malformed !== undefined) {
      result = badRequestResult(this.handler.manifest(), this.safeId(stem), malformed);
    } else {
      try {
        result = await this.handler.handle(parsed);
      } catch {
        result = internalErrorResult(this.handler.manifest(), this.safeId(stem));
      }
    }

    const outName = FILE_SAFE_ID.test(result.id) ? result.id : this.safeId(stem);
    await writeFileAtomic(join(this.resultsDir, `${outName}.json`), JSON.stringify(result));
    await unlink(filePath).catch(() => {});
    await writeFileAtomic(
      join(this.dir, 'state.json'),
      JSON.stringify(this.handler.state(), null, 2),
    );
  }

  private safeId(stem: string): string {
    return FILE_SAFE_ID.test(stem) ? stem : 'invalid';
  }
}

export interface DirectoryClientTransportOptions {
  dir: string;
  pollMs?: number;
  timeoutMs?: number;
}

/**
 * MEP Core 1 directory binding, client side. `send` writes `requests/.<id>.<random>.tmp` and then
 * hard-links it to `requests/<id>.json` — the link fails with EEXIST rather than overwriting
 * a request already on disk. Results are polled at `results/<id>.json` and validated against
 * CoreResult. Manifest and state are read from `mep.json` / `state.json`.
 */
export class DirectoryClientTransport implements ClientTransport {
  private readonly dir: string;
  private readonly pollMs: number;
  private readonly timeoutMs: number;
  private closed = false;

  constructor(opts: DirectoryClientTransportOptions) {
    this.dir = opts.dir;
    this.pollMs = opts.pollMs ?? 50;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private static checkId(id: string): void {
    if (id.includes('/') || id.includes('\\') || id.includes('..')) {
      throw new Error(`request id is not safe for the directory binding: ${JSON.stringify(id)}`);
    }
  }

  async send(req: CoreRequest): Promise<CoreResult> {
    if (this.closed) throw new Error('transport closed');
    DirectoryClientTransport.checkId(req.id);
    const requestsDir = join(this.dir, 'requests');
    // A fresh, exclusively created temp file per attempt: concurrent sends of the same id can
    // never write into each other's body before it is published.
    const tmp = join(requestsDir, `.${req.id}.${randomBytes(8).toString('hex')}.tmp`);
    const target = join(requestsDir, `${req.id}.json`);
    await writeFile(tmp, JSON.stringify(req), { mode: 0o600, flag: 'wx' });
    try {
      await link(tmp, target);
    } finally {
      await unlink(tmp).catch(() => {});
    }
    return this.waitForResult(req.id);
  }

  private async waitForResult(id: string): Promise<CoreResult> {
    const resultPath = join(this.dir, 'results', `${id}.json`);
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      try {
        return CoreResult.parse(JSON.parse(await readFile(resultPath, 'utf8')));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (this.closed) throw new Error('transport closed');
      if (Date.now() >= deadline) throw new Error(`timed out waiting for results/${id}.json`);
      await sleep(this.pollMs);
    }
  }

  async manifest(): Promise<CoreManifest> {
    return CoreManifest.parse(JSON.parse(await readFile(join(this.dir, 'mep.json'), 'utf8')));
  }

  async state(): Promise<CoreState> {
    return CoreState.parse(JSON.parse(await readFile(join(this.dir, 'state.json'), 'utf8')));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
