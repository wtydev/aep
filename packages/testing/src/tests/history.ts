/** Level `history`: undo / redo of committed transactions. */
import type { Loose } from '../context.js';
import { op } from '../ops.js';
import { defineLevel } from './define.js';

const t = defineLevel('history');
const REQ = ['aep.history'];

export const historyTests = [
  t(
    'undo-restores',
    'undo reverts the last commit and records an undo receipt',
    async (ctx) => {
      const before = await ctx.inspect();
      const commit = await ctx.commitOk([
        op.renameTrack('t-midi', 'Changed'),
        op.noteUpdate('n1', { pitch: 61 }),
      ]);
      const r = await ctx.call('history.undo', {});
      const rc = ctx.ok(r, 'undo');
      ctx.equal(rc.kind, 'undo', 'receipt kind');
      ctx.equal(rc.targetTransactionId, commit.transactionId, 'targetTransactionId');
      ctx.assert(
        rc.revision !== commit.revision && rc.revision !== before.revision,
        'undo must move to a new revision',
      );
      const after = await ctx.inspect();
      ctx.equal(after.revision, rc.revision, 'revision');
      ctx.same(after.project, before.project, 'project content after undo');
    },
    { requires: REQ },
  ),

  t(
    'redo-reapplies',
    'redo re-applies an undone commit',
    async (ctx) => {
      await ctx.commitOk([op.renameTrack('t-midi', 'Changed')]);
      const changed = await ctx.project();
      await ctx.callOk('history.undo', {});
      const rc = ctx.ok(await ctx.call('history.redo', {}), 'redo');
      ctx.equal(rc.kind, 'redo', 'receipt kind');
      ctx.same(await ctx.project(), changed, 'project content after redo');
    },
    { requires: REQ },
  ),

  t(
    'undo-multiple',
    'successive undos walk back through the commits in reverse order',
    async (ctx) => {
      const base = await ctx.project();
      await ctx.commitOk([op.renameTrack('t-midi', 'One')]);
      const one = await ctx.project();
      await ctx.commitOk([op.renameTrack('t-midi', 'Two')]);
      await ctx.callOk('history.undo', {});
      ctx.same(await ctx.project(), one, 'after first undo');
      await ctx.callOk('history.undo', {});
      ctx.same(await ctx.project(), base, 'after second undo');
      ctx.expectError(await ctx.call('history.undo', {}), 'nothing_to_undo');
    },
    { requires: REQ },
  ),

  t(
    'nothing-to-undo',
    'undo and redo on a fresh project report nothing_to_undo / nothing_to_redo',
    async (ctx) => {
      ctx.expectError(await ctx.call('history.undo', {}), 'nothing_to_undo', { next: 'none' });
      ctx.expectError(await ctx.call('history.redo', {}), 'nothing_to_redo', { next: 'none' });
      const h = await ctx.callOk('history.list', {});
      ctx.equal(h.canUndo, false, 'canUndo');
      ctx.equal(h.canRedo, false, 'canRedo');
    },
    { requires: REQ },
  ),

  t(
    'undo-conflict',
    'undoing a commit that later commits built on gives undo_conflict',
    async (ctx) => {
      const a = await ctx.commitOk([op.renameTrack('t-midi', 'A')]);
      await ctx.commitOk([op.renameTrack('t-midi', 'B')]);
      const before = await ctx.inspect();
      const r = await ctx.call('history.undo', { transactionId: a.transactionId });
      ctx.expectError(r, 'undo_conflict', { next: 'reread' });
      await ctx.expectUnchanged(before, 'after undo_conflict');
    },
    { requires: REQ },
  ),

  t(
    'undo-by-id-independent',
    'an earlier commit can be undone by id when later commits do not touch the same entities',
    async (ctx) => {
      const a = await ctx.commitOk([op.renameTrack('t-midi', 'A')]);
      await ctx.commitOk([op.renameTrack('t-audio', 'B')]);
      const rc = ctx.ok(await ctx.call('history.undo', { transactionId: a.transactionId }), 'undo');
      ctx.equal(rc.targetTransactionId, a.transactionId, 'target');
      const p = await ctx.project();
      ctx.equal(ctx.track(p, 't-midi').name, 'Keys', 'undone change');
      ctx.equal(ctx.track(p, 't-audio').name, 'B', 'later change kept');
    },
    { requires: REQ },
  ),

  t(
    'redo-cleared-by-commit',
    'a new commit discards the redo stack',
    async (ctx) => {
      await ctx.commitOk([op.renameTrack('t-midi', 'A')]);
      await ctx.callOk('history.undo', {});
      ctx.equal((await ctx.callOk('history.list', {})).canRedo, true, 'canRedo after undo');
      await ctx.commitOk([op.renameTrack('t-midi', 'B')]);
      ctx.equal(
        (await ctx.callOk('history.list', {})).canRedo,
        false,
        'canRedo after a new commit',
      );
      ctx.expectError(await ctx.call('history.redo', {}), 'nothing_to_redo');
    },
    { requires: REQ },
  ),

  t(
    'list',
    'history.list reports entries, undoneBy and the undo/redo flags',
    async (ctx) => {
      const a = await ctx.commitOk([op.renameTrack('t-midi', 'A')], { label: 'first' });
      const b = await ctx.commitOk([op.renameTrack('t-midi', 'B')], { label: 'second' });
      let h = await ctx.callOk('history.list', {});
      ctx.equal(h.canUndo, true, 'canUndo');
      ctx.equal(h.canRedo, false, 'canRedo');
      const ea = h.entries.find((e: Loose) => e.transactionId === a.transactionId);
      const eb = h.entries.find((e: Loose) => e.transactionId === b.transactionId);
      ctx.assert(ea && eb, 'entries missing');
      ctx.equal(ea.label, 'first', 'label');
      ctx.equal(ea.kind, 'commit', 'kind');
      ctx.equal(ea.baseRevision, a.baseRevision, 'baseRevision');
      ctx.equal(ea.revision, a.revision, 'revision');
      ctx.equal(ea.undoneBy, undefined, 'not undone yet');
      const u = await ctx.callOk('history.undo', {});
      h = await ctx.callOk('history.list', {});
      const eb2 = h.entries.find((e: Loose) => e.transactionId === b.transactionId);
      ctx.equal(eb2.undoneBy, u.transactionId, 'undoneBy');
      ctx.equal(h.canRedo, true, 'canRedo');
      const limited = await ctx.callOk('history.list', { limit: 1 });
      ctx.equal(limited.entries.length, 1, 'limit');
    },
    { requires: REQ },
  ),

  t(
    'undo-unknown-or-twice',
    'undoing an unknown or already-undone transaction is rejected',
    async (ctx) => {
      ctx.expectError(await ctx.call('history.undo', { transactionId: 'nope' }), 'not_found');
      const a = await ctx.commitOk([op.renameTrack('t-midi', 'A')]);
      await ctx.callOk('history.undo', { transactionId: a.transactionId });
      ctx.expectError(await ctx.call('history.undo', { transactionId: a.transactionId }), [
        'precondition_failed',
        'nothing_to_undo',
      ]);
    },
    { requires: REQ },
  ),

  t(
    'undo-proposal',
    'an accepted proposal can be undone',
    async (ctx) => {
      const before = await ctx.project();
      const p = await ctx.proposeOk([op.renameTrack('t-midi', 'Prop')]);
      const acc = await ctx.callOk('proposal.accept', { proposalId: p.id });
      const rc = ctx.ok(await ctx.call('history.undo', {}), 'undo');
      ctx.equal(rc.targetTransactionId, acc.transactionId, 'target');
      ctx.same(await ctx.project(), before, 'project after undo');
    },
    { requires: ['aep.history', 'aep.proposals'] },
  ),

  t(
    'undo-is-idempotent',
    'replaying an undo request id returns the identical result',
    async (ctx) => {
      await ctx.commitOk([op.renameTrack('t-midi', 'A')]);
      const id = ctx.uid('undo');
      const base = await ctx.revision();
      const first = await ctx.call('history.undo', {}, { id, base });
      ctx.equal(first.status, 'succeeded', 'undo');
      const second = await ctx.call('history.undo', {}, { id, base });
      ctx.same(second, first, 'replayed undo');
      ctx.equal(ctx.track(await ctx.project(), 't-midi').name, 'Keys', 'state');
    },
    { requires: REQ },
  ),

  t(
    'undo-restores-created-entities',
    'undo removes entities the commit created and redo restores them',
    async (ctx) => {
      await ctx.commitOk([
        op.addTrack('t-new', 'midi'),
        op.insertMidiClip('t-new', 'c-new', 0, 2, { notes: [op.note('q1')] }),
      ]);
      await ctx.callOk('history.undo', {});
      ctx.same(
        ctx.trackIds(await ctx.project()),
        ['t-midi', 't-audio', 't-bus'],
        'tracks after undo',
      );
      await ctx.callOk('history.redo', {});
      const p = await ctx.project();
      ctx.equal(ctx.clip(p, 'c-new').notes[0].id, 'q1', 'note restored by redo');
    },
    { requires: REQ },
  ),
];
