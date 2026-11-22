/**
 * Level `durability` (opt-in): state survives a host restart (SPECIFICATION.md section 17).
 *
 * Every test commits something, calls `ctx.restart()` (the launcher kills the host and starts it
 * again over the same data directory) and checks what the restarted host still knows. Skipped when
 * the host reports `host.durability: 'volatile'` or the launcher cannot restart it.
 */
import type { Loose, TestContext } from '../context.js';
import { INBOX } from '../fixture.js';
import { op } from '../ops.js';
import { ADMIN, defineLevel } from './define.js';

const t = defineLevel('durability');
const RESTART = { restart: true } as const;
const PATTERN = 'aep.reference.pattern';

/** Skip unless the host retains at least `n` completed requests per session. */
async function requireRetention(ctx: TestContext, n: number): Promise<void> {
  const { limits } = await ctx.callOk('aep.capabilities');
  if (limits.receiptRetention < n) {
    ctx.skip(`receiptRetention (${limits.receiptRetention}) is below the ${n} this test needs`);
  }
}

export const durabilityTests = [
  t(
    'state.survives-restart',
    'the project and its revision are unchanged after a restart',
    async (ctx) => {
      await ctx.commitOk([op.renameTrack('t-midi', 'Durable'), op.noteUpdate('n1', { pitch: 61 })]);
      await ctx.commitOk([op.addTrack('t-extra', 'midi')]);
      const before = await ctx.inspect();
      await ctx.restart();
      const after = await ctx.inspect();
      ctx.equal(after.revision, before.revision, 'revision after restart');
      ctx.same(after.project, before.project, 'project after restart');
      // The restarted host keeps accepting commits on top of the restored revision.
      const rc = await ctx.commitOk([op.renameTrack('t-midi', 'Again')]);
      ctx.differs(rc.revision, before.revision, 'a new revision after restart');
    },
    RESTART,
  ),

  t(
    'replay.after-restart',
    'a request id used before the restart replays the identical result',
    async (ctx) => {
      await requireRetention(ctx, 8);
      const id = ctx.uid('idem');
      const base = await ctx.revision();
      const ops = [op.renameTrack('t-midi', 'Once')];
      const first = await ctx.commit(ops, {}, { id, base });
      ctx.equal(first.status, 'succeeded', 'first commit');
      await ctx.restart();
      const second = await ctx.commit(ops, {}, { id, base });
      ctx.same(second, first, 'replayed result after restart');
      ctx.equal(await ctx.revision(), first.revision, 'a replay must not create a revision');
      // The same id with other content is still an id_conflict.
      const other = await ctx.commit([op.renameTrack('t-midi', 'Other')], {}, { id, base });
      ctx.expectError(other, 'id_conflict', { next: 'fix' });
    },
    RESTART,
  ),

  t(
    'receipt.after-restart',
    'receipt.get still returns committed and rejected requests after a restart',
    async (ctx) => {
      await requireRetention(ctx, 16);
      const okId = ctx.uid('ok');
      const okResult = await ctx.commit(
        [op.renameTrack('t-midi', 'Receipted')],
        {},
        { id: okId, base: await ctx.revision() },
      );
      ctx.equal(okResult.status, 'succeeded', 'commit');
      const before = await ctx.receipt(okId);
      const badId = ctx.uid('bad');
      const bad = await ctx.commit(
        [op.renameClip('ghost-clip', 'x')],
        {},
        { id: badId, base: await ctx.revision() },
      );
      ctx.assert(bad.status !== 'succeeded', 'commit on a missing clip succeeded');
      const badBefore = await ctx.receipt(badId);
      await ctx.restart();
      ctx.same(await ctx.receipt(okId), before, 'receipt of the commit');
      const badAfter = await ctx.receipt(badId);
      ctx.equal(badAfter.errorCode, badBefore.errorCode, 'errorCode of the rejected commit');
      ctx.assert(badAfter.diagnostics.length > 0, 'diagnostics lost in the restart');
    },
    RESTART,
  ),

  t(
    'history.undo-after-restart',
    'a commit made before the restart can be undone, then redone, afterwards',
    async (ctx) => {
      const before = await ctx.inspect();
      const commit = await ctx.commitOk([op.renameTrack('t-midi', 'Undoable')]);
      const changed = await ctx.project();
      await ctx.restart();
      const rc = ctx.ok(await ctx.call('history.undo', {}), 'undo after restart');
      ctx.equal(rc.targetTransactionId, commit.transactionId, 'targetTransactionId');
      ctx.same(await ctx.project(), before.project, 'project after undo');
      await ctx.restart();
      ctx.ok(await ctx.call('history.redo', {}), 'redo after a second restart');
      ctx.same(await ctx.project(), changed, 'project after redo');
    },
    { ...RESTART, requires: ['aep.history'] },
  ),

  t(
    'proposals.open-survives-restart',
    'an open proposal survives a restart and can be accepted',
    async (ctx) => {
      const p = await ctx.proposeOk([op.renameTrack('t-midi', 'Proposed')], { label: 'durable' });
      const listed = await ctx.callOk('proposal.get', { proposalId: p.id });
      await ctx.restart();
      const got = await ctx.callOk('proposal.get', { proposalId: p.id });
      ctx.equal(got.proposal.status, 'open', 'status after restart');
      ctx.same(got.proposal.operations, listed.proposal.operations, 'operations after restart');
      ctx.equal(ctx.track(await ctx.project(), 't-midi').name, 'Keys', 'proposal not applied');
      const rc = ctx.ok(await ctx.call('proposal.accept', { proposalId: p.id }), 'accept');
      ctx.equal(rc.kind, 'proposal', 'receipt kind');
      ctx.equal(ctx.track(await ctx.project(), 't-midi').name, 'Proposed', 'state after accept');
    },
    { ...RESTART, requires: ['aep.proposals'], sessions: ADMIN },
  ),

  t(
    'session.credential-survives-restart',
    'the session and its credential are still valid after a restart',
    async (ctx) => {
      const session = ctx.client.session;
      const credential = ctx.credential();
      await ctx.restart();
      ctx.equal(ctx.credential(), credential, 'credential after restart');
      ctx.equal(ctx.client.session, session, 'session id after restart');
      // A request with the pre-restart credential is accepted ...
      const r = await ctx.raw({ action: 'project.describe' });
      ctx.equal(
        r.status,
        'succeeded',
        `project.describe after restart: ${JSON.stringify(r.error)}`,
      );
      // ... and a wrong credential is still refused.
      const bad = await ctx.raw({ action: 'project.describe', credential: `${credential}x` });
      ctx.assert(bad.status !== 'succeeded', 'a wrong credential was accepted after restart');
    },
    RESTART,
  ),

  t(
    'assets.store-survives-restart',
    'an imported asset is still in the host store, unchanged, after a restart',
    async (ctx) => {
      const { asset } = await ctx.callOk('asset.import', { path: INBOX.wav });
      await ctx.restart();
      const store = await ctx.callOk('asset.list', { store: true });
      const after = store.assets.find((a: Loose) => a.id === asset.id);
      ctx.assert(after !== undefined, 'imported asset missing from the store after restart');
      ctx.same(after, asset, 'asset descriptor after restart');
    },
    { ...RESTART, requires: ['aep.audio.assets.import'], sessions: ADMIN },
  ),

  t(
    'jobs.finished-survives-restart',
    'a finished job keeps its state and result after a restart',
    async (ctx) => {
      const caps = await ctx.callOk('aep.capabilities');
      if (!caps.generators.some((g: Loose) => g.id === PATTERN)) {
        ctx.skip(`host offers no '${PATTERN}' generator (reference executors not enabled)`);
      }
      const { job } = await ctx.callOk('generation.request', {
        generator: PATTERN,
        parameters: { pitches: [60, 64], stepBeats: 0.5, count: 4 },
        seed: 7,
      });
      const done = await ctx.waitForJob(job.id);
      ctx.equal(done.state, 'succeeded', 'generation job state');
      await ctx.restart();
      const { job: after } = await ctx.callOk('job.status', { jobId: job.id });
      ctx.equal(after.state, 'succeeded', 'job state after restart');
      ctx.same(after.result, done.result, 'job result after restart');
    },
    { ...RESTART, requires: ['aep.generation', 'aep.jobs'] },
  ),
];
