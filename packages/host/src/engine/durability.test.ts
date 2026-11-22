import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '@wty.dev/aep-core';
import { demoProject } from '../domain/fixtures.js';
import { AepHost } from './host.js';
import type { AepHostOptions, CreateSessionOptions } from './host.js';
import { PATTERN_GENERATOR_ID, referenceExecutors } from './fixture-executors.js';
import type { JobExecutor } from './jobs.js';
import { PersistenceError, StateFiles } from './persistence.js';
import { TestClient, TestClock, errorCode, output, renameTrack } from './test-harness.js';
import type { Loose } from './test-harness.js';

function wavBytes(frames = 4800): Buffer {
  const dataSize = frames * 2;
  const b = Buffer.alloc(44 + dataSize);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataSize, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48_000, 24);
  b.writeUInt32LE(96_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i++) b.writeInt16LE((i * 37) % 2000, 44 + i * 2);
  return b;
}

let base: string;
let dataDir: string;
let inbox: string;
const clock = new TestClock();

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'aep-durable-')));
  dataDir = join(base, 'data');
  inbox = join(base, 'inbox');
  mkdirSync(inbox);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(base, { recursive: true, force: true });
});

const open = (dir = dataDir, extra: Partial<AepHostOptions> = {}): Promise<AepHost> =>
  AepHost.open({
    project: demoProject(),
    dataDir: dir,
    clock: clock.read,
    executors: referenceExecutors(),
    assertResults: true,
    ...extra,
  });

interface Grant {
  session: string;
  credential: string;
  workspace: string;
}

async function grant(
  host: AepHost,
  opts: Partial<CreateSessionOptions> & { role: CreateSessionOptions['role'] },
): Promise<{ client: TestClient; grant: Grant }> {
  const g = host.createSession({ client: `client-${opts.role}`, ...opts });
  await host.flush();
  return { client: new TestClient(host, g.session, g.credential, g.workspace), grant: g };
}

/** A client for an existing session whose generated request ids never collide with earlier clients'. */
let epoch = 0;
class ReattachedClient extends TestClient {
  private readonly prefix = `re${++epoch}`;
  override nextId(): string {
    return `${this.prefix}-${super.nextId()}`;
  }
}
const reattach = (host: AepHost, g: Grant): TestClient =>
  new ReattachedClient(host, g.session, g.credential, g.workspace);

const statePath = (dir = dataDir): string => join(dir, 'host-state.json');
const readState = (dir = dataDir): Loose => JSON.parse(readFileSync(statePath(dir), 'utf8'));
const trackName = (host: AepHost, session: string, id: string): string | undefined =>
  host.state(session).data.tracks.find((t) => t.id === id)?.name;

describe('durable host: open / restore', () => {
  it('commit → reopen keeps revision, project, history and receipt.get', async () => {
    const h1 = await open();
    const { client, grant: g } = await grant(h1, { role: 'edit' });
    const commit = await client.commit(
      [renameTrack('t-midi', 'Durable')],
      { label: 'rename' },
      { id: 'c1' },
    );
    const receipt = output(commit);
    const before = {
      revision: h1.revision,
      project: JSON.stringify(h1.state(g.session).data),
      history: output(await client.call('history.list')),
      rec: output(await client.call('receipt.get', { requestId: 'c1' })),
    };
    expect(before.revision).toBe('rev-1');

    const h2 = await open();
    const c2 = reattach(h2, g);
    expect(h2.revision).toBe('rev-1');
    expect(JSON.stringify(h2.state(g.session).data)).toBe(before.project);
    expect(output(await c2.call('history.list'))).toEqual(before.history);
    const rec = output(await c2.call('receipt.get', { requestId: 'c1' }));
    expect(rec).toEqual(before.rec);
    expect(rec.receipt).toEqual(receipt);
  });

  it('replaying a request id after reopen returns a byte-identical result; a different body is id_conflict', async () => {
    const h1 = await open();
    const { client, grant: g } = await grant(h1, { role: 'edit' });
    const req = client.request(
      'transaction.commit',
      { transaction: { operations: [renameTrack('t-midi', 'X')] } },
      { id: 'once', baseRevision: h1.revision },
    );
    const first = await h1.handle(req);
    expect(first.status).toBe('succeeded');

    const h2 = await open();
    const again = await h2.handle(req);
    expect(JSON.stringify(again)).toBe(JSON.stringify(first));
    expect(h2.revision).toBe('rev-1'); // not executed twice

    const c2 = reattach(h2, g);
    const conflict = await c2.commit(
      [renameTrack('t-midi', 'Y')],
      {},
      { id: 'once', baseRevision: 'rev-1' },
    );
    expect(errorCode(conflict)).toBe('id_conflict');
  });

  it('undo and redo work after reopen, including targets of earlier undos', async () => {
    const h1 = await open();
    const { client, grant: g } = await grant(h1, { role: 'edit' });
    await client.commit([renameTrack('t-midi', 'One')]);
    await client.commit([renameTrack('t-midi', 'Two')]);
    await client.write('history.undo', {});
    expect(trackName(h1, g.session, 't-midi')).toBe('One');

    const h2 = await open();
    const c2 = reattach(h2, g);
    const list = output(await c2.call('history.list'));
    expect(list.canRedo).toBe(true);
    expect(output(await c2.write('history.redo', {})).kind).toBe('redo');
    expect(trackName(h2, g.session, 't-midi')).toBe('Two');
    expect(output(await c2.write('history.undo', {})).kind).toBe('undo');
    expect(trackName(h2, g.session, 't-midi')).toBe('One');

    const h3 = await open();
    const c3 = reattach(h3, g);
    expect(h3.revision).toBe('rev-5');
    expect(output(await c3.write('history.undo', {})).kind).toBe('undo');
    expect(trackName(h3, g.session, 't-midi')).toBeDefined();
  });

  it('an open proposal survives a reopen and can be accepted; a closed one stays closed', async () => {
    const h1 = await open();
    const { client: proposer } = await grant(h1, { role: 'propose' });
    const { client: admin, grant: ga } = await grant(h1, { role: 'admin' });
    const open1 = output(
      await proposer.propose([renameTrack('t-midi', 'Proposed')], { proposalId: 'p-open' }),
    );
    output(await proposer.propose([renameTrack('t-midi', 'Nope')], { proposalId: 'p-rej' }));
    output(await admin.write('proposal.reject', { proposalId: 'p-rej' }));

    const h2 = await open();
    const a2 = reattach(h2, ga);
    const got = output(await a2.call('proposal.get', { proposalId: 'p-open', includeState: true }));
    expect(got.proposal).toEqual(open1);
    expect(got.state.tracks.find((t: { id: string }) => t.id === 't-midi').name).toBe('Proposed');
    const rejected = output(
      await a2.call('proposal.get', { proposalId: 'p-rej', includeState: true }),
    );
    expect(rejected.proposal.status).toBe('rejected');
    expect(rejected.state).toBeUndefined();

    const accepted = output(await a2.write('proposal.accept', { proposalId: 'p-open' }));
    expect(accepted.kind).toBe('proposal');
    expect(trackName(h2, ga.session, 't-midi')).toBe('Proposed');
  });

  it('imported asset bytes survive a reopen, stored content-addressed; corrupted bytes refuse to open', async () => {
    const bytes = wavBytes();
    writeFileSync(join(inbox, 'take.wav'), bytes);
    const h1 = await open(dataDir, { importRoots: { inbox } });
    const { client, grant: g } = await grant(h1, { role: 'admin' });
    const { asset } = output(await client.write('asset.import', { path: 'take.wav' }));
    const hex = sha256Hex(bytes);
    expect(asset.contentHash).toBe(`sha256:${hex}`);
    expect(readFileSync(join(dataDir, 'assets', hex)).equals(bytes)).toBe(true);

    const h2 = await open(dataDir, { importRoots: { inbox } });
    const c2 = reattach(h2, g);
    const store = output(await c2.call('asset.list', { store: true })).assets;
    expect(store).toEqual([asset]);

    writeFileSync(join(dataDir, 'assets', hex), Buffer.from('tampered'));
    await expect(open(dataDir, { importRoots: { inbox } })).rejects.toThrow(/corrupt/);
  });

  it('a render job that was running becomes failed(internal_error) after a reopen; finished jobs keep their result', async () => {
    const hang: JobExecutor = {
      kind: 'render',
      id: 'hang',
      describe: () => ({ outputs: ['audio'], deterministic: true }),
      run: (_input, ctx) =>
        new Promise((_resolve, reject) =>
          ctx.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    };
    const h1 = await open(dataDir, {
      executors: [hang, ...referenceExecutors().filter((e) => e.kind === 'generation')],
    });
    const { client, grant: g } = await grant(h1, { role: 'edit' });
    const gen = output(
      await client.write('generation.request', {
        generator: PATTERN_GENERATOR_ID,
        parameters: { pitches: [60, 64], stepBeats: 0.25, count: 2 },
        seed: 1,
        target: { trackId: 't-midi' },
      }),
    );
    await h1.waitForJobs().catch(() => undefined);
    const stuck = output(
      await client.write('render.request', {
        target: 'mix',
        format: { container: 'wav', sampleRate: 48_000 },
      }),
    ).job;
    await new Promise((r) => setImmediate(r));
    expect(output(await client.call('job.status', { jobId: stuck.id })).job.state).toBe('running');
    await h1.flush();
    const doneBefore = output(await client.call('job.status', { jobId: gen.job.id })).job;

    const h2 = await open(dataDir);
    const c2 = reattach(h2, g);
    const restored = output(await c2.call('job.status', { jobId: stuck.id })).job;
    expect(restored.state).toBe('failed');
    expect(restored.error).toEqual({
      code: 'internal_error',
      message: 'interrupted by host restart',
    });
    const finished = output(await c2.call('job.status', { jobId: gen.job.id })).job;
    expect(finished.state).toBe(doneBefore.state);
    if (doneBefore.state === 'succeeded') expect(finished.result).toEqual(doneBefore.result);

    // the interruption itself was persisted
    const h3 = await open(dataDir);
    expect(output(await reattach(h3, g).call('job.status', { jobId: stuck.id })).job.state).toBe(
      'failed',
    );
  });

  it('ignores options.project when a state file exists', async () => {
    const h1 = await open();
    const { client, grant: g } = await grant(h1, { role: 'edit' });
    await client.commit([renameTrack('t-midi', 'Kept')]);
    const other = { ...demoProject(), name: 'A different project' };
    const h2 = await open(dataDir, { project: other });
    expect(h2.revision).toBe('rev-1');
    expect(trackName(h2, g.session, 't-midi')).toBe('Kept');
    expect(h2.state(g.session).data.name).not.toBe('A different project');
  });

  it('starts from options.project and persists immediately when there is no state file', async () => {
    const h1 = await open();
    expect(h1.revision).toBe('rev-0');
    expect(readState().formatVersion).toBe(1);
    expect(readState().project.id).toBe(h1.projectId);
  });

  it('rejects a relative dataDir', async () => {
    await expect(open('relative/dir')).rejects.toThrow(/absolute/);
  });
});

describe('durable host: sessions', () => {
  it('a session credential still authenticates after a reopen; wrong credentials do not', async () => {
    const h1 = await open();
    const { grant: g } = await grant(h1, { role: 'read' });
    const h2 = await open();
    const c2 = reattach(h2, g);
    expect((await c2.call('project.inspect')).status).toBe('succeeded');
    const bad = await c2.call('project.inspect', {}, { credential: 'not-the-credential' });
    expect(errorCode(bad)).toBe('not_authorized');
  });

  it('revoked and expired sessions stay that way', async () => {
    const h1 = await open();
    const revoked = await grant(h1, { role: 'read' });
    const expiring = await grant(h1, { role: 'read', expiresAt: clock.now + 1000 });
    h1.revokeSession(revoked.grant.session);
    await h1.flush();
    clock.advance(5000);
    try {
      const h2 = await open();
      expect(errorCode(await reattach(h2, revoked.grant).call('project.inspect'))).toBe(
        'session_revoked',
      );
      expect(errorCode(await reattach(h2, expiring.grant).call('project.inspect'))).toBe(
        'session_expired',
      );
    } finally {
      clock.advance(-5000);
    }
  });

  it('scope and allowedActions are restored', async () => {
    const h1 = await open();
    const limited = await grant(h1, {
      role: 'edit',
      allowedActions: ['project.inspect'],
      scope: { tracks: ['t-audio'] },
    });
    const h2 = await open();
    const c2 = reattach(h2, limited.grant);
    expect((await c2.call('project.inspect')).status).toBe('succeeded');
    expect(errorCode(await c2.commit([renameTrack('t-midi', 'No')]))).toBe('not_authorized');
    expect(h2.manifest(limited.grant.session).actions.map((a) => a.id)).toEqual([
      'project.inspect',
    ]);
  });
});

describe('durable host: write-ahead and crash recovery', () => {
  it('a reservation without a result becomes outcome_uncertain and never re-executes', async () => {
    const h1 = await open();
    const { client, grant: g } = await grant(h1, { role: 'edit' });
    const crashDir = join(base, 'crash');
    const original = StateFiles.prototype.write;
    let calls = 0;
    vi.spyOn(StateFiles.prototype, 'write').mockImplementation(async function (
      this: StateFiles,
      ...args
    ) {
      await original.apply(this, args);
      calls += 1;
      // The first write is the reservation: copy the directory as a crash right after it would leave it.
      if (calls === 1) cpSync(dataDir, crashDir, { recursive: true });
    });
    const req = client.request(
      'transaction.commit',
      { transaction: { operations: [renameTrack('t-midi', 'Lost?')] } },
      { id: 'crashy', baseRevision: h1.revision },
    );
    expect((await h1.handle(req)).status).toBe('succeeded');
    expect(calls).toBe(2); // reservation, then final state
    vi.restoreAllMocks();

    const pending = readState(crashDir);
    expect(pending.reservations).toEqual([
      { session: g.session, id: 'crashy', action: 'transaction.commit' },
    ]);
    expect(pending.revision).toBe('rev-0');

    const h2 = await open(crashDir);
    expect(h2.revision).toBe('rev-0');
    const c2 = reattach(h2, g);
    const retry = await h2.handle(req);
    expect(retry.status).toBe('indeterminate');
    expect(retry.error).toMatchObject({ code: 'outcome_uncertain', next: 'reconcile' });
    expect(h2.revision).toBe('rev-0'); // the retry did not run the effect
    const rec = output(await c2.call('receipt.get', { requestId: 'crashy' }));
    expect(rec).toMatchObject({
      action: 'transaction.commit',
      status: 'indeterminate',
      errorCode: 'outcome_uncertain',
    });

    // stable across another restart
    const h3 = await open(crashDir);
    expect(JSON.stringify(await h3.handle(req))).toBe(JSON.stringify(retry));
    expect(readState(crashDir).reservations).toEqual([]);
  });

  it('the effect is on disk before the result is returned', async () => {
    const h1 = await open();
    const { client } = await grant(h1, { role: 'edit' });
    const result = await client.commit([renameTrack('t-midi', 'OnDisk')], {}, { id: 'w1' });
    expect(result.status).toBe('succeeded');
    const state = readState();
    expect(state.revision).toBe('rev-1');
    expect(state.history).toHaveLength(1);
    const records = state.ledger.sessions.flatMap((s: Loose) => s.records);
    expect(records.find((r: Loose) => r.id === 'w1').result.status).toBe('succeeded');
  });

  it('concurrent requests never interleave and all end up durable', async () => {
    const h1 = await open();
    const { client, grant: g } = await grant(h1, { role: 'admin' });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        client.call(
          'proposal.create',
          { transaction: { operations: [renameTrack('t-midi', `N${i}`)] }, proposalId: `p${i}` },
          { id: `par-${i}`, baseRevision: 'rev-0' },
        ),
      ),
    );
    expect(results.every((r) => r.status === 'succeeded')).toBe(true);
    const h2 = await open();
    const ids = output(await reattach(h2, g).call('proposal.list'))
      .proposals.map((p: { id: string }) => p.id)
      .sort();
    expect(ids).toEqual(Array.from({ length: 8 }, (_, i) => `p${i}`));
  });
});

describe('durable host: persistence failures', () => {
  const failOnCall = (n: number, committed: boolean): void => {
    const original = StateFiles.prototype.write;
    let calls = 0;
    vi.spyOn(StateFiles.prototype, 'write').mockImplementation(async function (
      this: StateFiles,
      ...args
    ) {
      calls += 1;
      if (calls === n) {
        if (committed) await original.apply(this, args);
        throw new PersistenceError('disk is unhappy', committed);
      }
      return original.apply(this, args);
    });
  };

  it('a failed reservation write runs nothing and leaves the id reusable', async () => {
    const h1 = await open();
    const { client } = await grant(h1, { role: 'edit' });
    failOnCall(1, false);
    const failed = await client.commit(
      [renameTrack('t-midi', 'Never')],
      {},
      { id: 'r1', baseRevision: 'rev-0' },
    );
    expect(failed.status).toBe('failed');
    expect(errorCode(failed)).toBe('internal_error');
    expect(h1.revision).toBe('rev-0');
    vi.restoreAllMocks();
    const retry = await client.commit(
      [renameTrack('t-midi', 'Now')],
      {},
      { id: 'r1', baseRevision: 'rev-0' },
    );
    expect(retry.status).toBe('succeeded'); // the abandoned reservation left no trace: same id is reusable
    expect(h1.revision).toBe('rev-1');
  });

  it('a failed final write that cannot have reached disk is rolled back (failed, retryable)', async () => {
    const h1 = await open();
    const { client, grant: g } = await grant(h1, { role: 'edit' });
    const req = client.request(
      'transaction.commit',
      { transaction: { operations: [renameTrack('t-midi', 'Rolled')] } },
      { id: 'f1', baseRevision: 'rev-0' },
    );
    failOnCall(2, false);
    const failed = await h1.handle(req);
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('internal_error');
    expect(h1.revision).toBe('rev-0');
    expect(trackName(h1, g.session, 't-midi')).toBe('Keys');
    expect(output(await client.call('history.list')).entries).toEqual([]);
    vi.restoreAllMocks();

    const retry = await h1.handle(req); // same id, same body: executes now
    expect(retry.status).toBe('succeeded');
    expect(h1.revision).toBe('rev-1');
    const h2 = await open();
    expect(JSON.stringify(await h2.handle(req))).toBe(JSON.stringify(retry));
  });

  it('a final write that may have reached disk reports outcome_uncertain, and the next write resolves it', async () => {
    const h1 = await open();
    const { client, grant: g } = await grant(h1, { role: 'edit' });
    const req = client.request(
      'transaction.commit',
      { transaction: { operations: [renameTrack('t-midi', 'Maybe')] } },
      { id: 'u1', baseRevision: 'rev-0' },
    );
    failOnCall(2, true);
    const uncertain = await h1.handle(req);
    expect(uncertain.status).toBe('indeterminate');
    expect(uncertain.error).toMatchObject({ code: 'outcome_uncertain', next: 'reconcile' });
    vi.restoreAllMocks();
    // memory kept the effect; the stored answer is the uncertain one, never a success
    expect(h1.revision).toBe('rev-1');
    expect(JSON.stringify(await h1.handle(req))).toBe(JSON.stringify(uncertain));
    const rec = output(await client.call('receipt.get', { requestId: 'u1' }));
    expect(rec.status).toBe('indeterminate');
    // a crash right now replays the same uncertain answer, not the success the renamed file held
    const crashed = await open();
    expect(JSON.stringify(await crashed.handle(req))).toBe(JSON.stringify(uncertain));

    output(await client.commit([renameTrack('t-midi', 'Later')], {}, { id: 'u2' }));
    const h2 = await open();
    expect(h2.revision).toBe('rev-2');
    expect(JSON.stringify(await h2.handle(req))).toBe(JSON.stringify(uncertain));
    expect(trackName(h2, g.session, 't-midi')).toBe('Later');
  });
  it('if the uncertain answer cannot be persisted either, the host refuses further requests', async () => {
    const h1 = await open();
    const { client } = await grant(h1, { role: 'edit' });
    const original = StateFiles.prototype.write;
    let calls = 0;
    vi.spyOn(StateFiles.prototype, 'write').mockImplementation(async function (
      this: StateFiles,
      ...args
    ) {
      calls += 1;
      if (calls === 1) return original.apply(this, args);
      if (calls === 2) await original.apply(this, args);
      throw new PersistenceError('disk is unhappy', true);
    });
    const uncertain = await client.commit([renameTrack('t-midi', 'Maybe')], {}, { id: 'b1' });
    expect(errorCode(uncertain)).toBe('outcome_uncertain');
    vi.restoreAllMocks();
    const refused = await client.call('project.inspect');
    expect(errorCode(refused)).toBe('internal_error');
    expect(refused.error?.message).toMatch(/restart/);
  });
});

describe('durable host: persistence failures (effects)', () => {
  it('a job starts only after the request that created it is durable', async () => {
    let ran = 0;
    const counting: JobExecutor = {
      kind: 'render',
      id: 'counting',
      describe: () => ({ outputs: ['audio'], deterministic: true }),
      run: async () => {
        ran += 1;
        throw new Error('not needed');
      },
    };
    const h1 = await open(dataDir, { executors: [counting] });
    const { client } = await grant(h1, { role: 'edit' });
    const original = StateFiles.prototype.write;
    let calls = 0;
    vi.spyOn(StateFiles.prototype, 'write').mockImplementation(async function (
      this: StateFiles,
      ...args
    ) {
      calls += 1;
      if (calls === 2) {
        await new Promise((r) => setTimeout(r, 20)); // give an eager executor time to start
        throw new PersistenceError('disk is unhappy', false);
      }
      return original.apply(this, args);
    });
    const failed = await client.write('render.request', {
      target: 'mix',
      format: { container: 'wav', sampleRate: 48_000 },
    });
    expect(errorCode(failed)).toBe('internal_error');
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(0);
    vi.restoreAllMocks();
    output(
      await client.write('render.request', {
        target: 'mix',
        format: { container: 'wav', sampleRate: 48_000 },
      }),
    );
    await h1.waitForJobs().catch(() => undefined);
    expect(ran).toBe(1);
  });

  it('a rejected request whose final write fails leaves memory equal to disk', async () => {
    const h1 = await open();
    const { client, grant: g } = await grant(h1, { role: 'admin' });
    // Two proposals on the same base; accepting the first makes the second conflict.
    output(await client.propose([renameTrack('t-midi', 'A')], { proposalId: 'pa' }));
    output(await client.propose([renameTrack('t-midi', 'B')], { proposalId: 'pb' }));
    output(await client.write('proposal.accept', { proposalId: 'pa' }));
    const original = StateFiles.prototype.write;
    let calls = 0;
    vi.spyOn(StateFiles.prototype, 'write').mockImplementation(async function (
      this: StateFiles,
      ...args
    ) {
      calls += 1;
      if (calls === 2) throw new PersistenceError('disk is unhappy', false);
      return original.apply(this, args);
    });
    const r = await client.write('proposal.accept', { proposalId: 'pb' });
    vi.restoreAllMocks();
    expect(errorCode(r)).toBe('internal_error');
    const inMemory = output(await client.call('proposal.get', { proposalId: 'pb' })).proposal;
    const onDisk = output(
      await reattach(await open(), g).call('proposal.get', { proposalId: 'pb' }),
    ).proposal;
    expect(inMemory.status).toBe(onDisk.status);
  });
});

describe('durable host: files', () => {
  it('uses mode 0600 for files and 0700 for directories, leaves no temp files, stores no credentials or paths', async () => {
    writeFileSync(join(inbox, 'take.wav'), wavBytes());
    const h1 = await open(dataDir, { importRoots: { inbox } });
    const { client, grant: g } = await grant(h1, { role: 'admin' });
    output(await client.write('asset.import', { path: 'take.wav' }));
    await h1.flush();

    const mode = (p: string): number => statSync(p).mode & 0o777;
    expect(mode(dataDir)).toBe(0o700);
    expect(mode(join(dataDir, 'assets'))).toBe(0o700);
    expect(mode(statePath())).toBe(0o600);
    const blobs = readdirSync(join(dataDir, 'assets'));
    expect(blobs).toHaveLength(1);
    expect(mode(join(dataDir, 'assets', blobs[0]!))).toBe(0o600);
    expect(readdirSync(dataDir).sort()).toEqual(['assets', 'host-state.json']);

    const text = readFileSync(statePath(), 'utf8');
    expect(text).not.toContain(g.credential);
    expect(text).toContain(sha256Hex(g.credential));
    expect(text).not.toContain(base);
  });

  it('replaces a stray blob whose bytes do not match its name instead of trusting it', async () => {
    const wav = wavBytes();
    await open();
    writeFileSync(join(dataDir, 'assets', sha256Hex(wav)), 'garbage', { mode: 0o600 });
    writeFileSync(join(inbox, 'take.wav'), wav);
    const h1 = await open(dataDir, { importRoots: { inbox } });
    const { client } = await grant(h1, { role: 'admin' });
    output(await client.write('asset.import', { path: 'take.wav' }));
    await h1.flush();
    expect(readFileSync(join(dataDir, 'assets', sha256Hex(wav)))).toEqual(wav);
    await expect(open()).resolves.toBeInstanceOf(AepHost);
  });

  it('refuses a data directory it does not control', async () => {
    const real = join(base, 'real');
    mkdirSync(real, { mode: 0o700 });
    const link = join(base, 'link');
    symlinkSync(real, link);
    await expect(open(link)).rejects.toThrow(/symlink/);

    const loose = join(base, 'loose');
    mkdirSync(loose);
    chmodSync(loose, 0o777);
    await expect(open(loose)).rejects.toThrow(/writable by group or others/);

    await open();
    const elsewhere = join(base, 'elsewhere.json');
    cpSync(statePath(), elsewhere);
    rmSync(statePath());
    symlinkSync(elsewhere, statePath());
    await expect(open()).rejects.toThrow(/symlink/);
  });

  it('refuses a state file with an unknown formatVersion', async () => {
    await open();
    const state = readState();
    state.formatVersion = 2;
    writeFileSync(statePath(), JSON.stringify(state));
    await expect(open()).rejects.toThrow(/formatVersion/);
    writeFileSync(statePath(), JSON.stringify({ project: {} }));
    await expect(open()).rejects.toThrow(/formatVersion/);
    writeFileSync(statePath(), 'not json');
    await expect(open()).rejects.toThrow(/JSON/);
  });

  it('refuses a malformed state file', async () => {
    await open();
    const state = readState();
    state.sessions = 'nope';
    writeFileSync(statePath(), JSON.stringify(state));
    await expect(open()).rejects.toThrow(/corrupt/);
  });
});

describe('durability declaration', () => {
  it('aep.capabilities reports durable with a dataDir and volatile without', async () => {
    const durable = await open();
    const { client } = await grant(durable, { role: 'read' });
    expect(output(await client.call('aep.capabilities')).host).toMatchObject({
      name: 'aep-reference-host',
      version: '1.0.0',
      durability: 'durable',
    });

    const volatile = new AepHost({ project: demoProject(), clock: clock.read });
    const g = volatile.createSession({ client: 'v', role: 'read' });
    const out = output(
      await new TestClient(volatile, g.session, g.credential, g.workspace).call('aep.capabilities'),
    );
    expect(out.host.durability).toBe('volatile');
    expect(volatile.flush()).resolves.toBeUndefined();
  });

  it('the synchronous constructor rejects dataDir and points to open()', () => {
    // Not in the AepHostOptions type; guards untyped (JavaScript) callers.
    const options = { project: demoProject(), dataDir } as AepHostOptions;
    expect(() => new AepHost(options)).toThrow(/AepHost\.open/);
  });
});
