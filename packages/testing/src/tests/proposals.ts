/** Level `proposals`: isolated change sets that an editor accepts or rejects. */
import type { Loose } from '../context.js';
import { op } from '../ops.js';
import { defineLevel } from './define.js';

const t = defineLevel('proposals');
const REQ = ['aep.proposals'];

export const proposalTests = [
  t(
    'create-isolated',
    'a proposal does not change the project or its revision',
    async (ctx) => {
      const before = await ctx.inspect();
      const p = await ctx.proposeOk([op.renameTrack('t-midi', 'Proposed')], { label: 'rename' });
      ctx.equal(p.status, 'open', 'status');
      ctx.equal(p.baseRevision, before.revision, 'baseRevision');
      ctx.equal(p.label, 'rename', 'label');
      ctx.same(p.operations, [op.renameTrack('t-midi', 'Proposed')], 'operations');
      ctx.assert(
        p.changes.some((c: Loose) => c.path === '/tracks/t-midi'),
        'changes lack the track',
      );
      await ctx.expectUnchanged(before, 'after proposal.create');
    },
    { requires: REQ },
  ),

  t(
    'get-with-state',
    'proposal.get returns the proposal and, on request, the proposed state',
    async (ctx) => {
      const p = await ctx.proposeOk([op.renameTrack('t-midi', 'Proposed')]);
      const plain = await ctx.callOk('proposal.get', { proposalId: p.id });
      ctx.equal(plain.proposal.id, p.id, 'proposal id');
      ctx.equal(plain.state, undefined, 'no state unless requested');
      const withState = await ctx.callOk('proposal.get', { proposalId: p.id, includeState: true });
      ctx.equal(ctx.track(withState.state, 't-midi').name, 'Proposed', 'proposed state');
      ctx.equal(ctx.track(await ctx.project(), 't-midi').name, 'Keys', 'accepted state untouched');
      ctx.expectError(await ctx.call('proposal.get', { proposalId: 'nope' }), 'not_found');
    },
    { requires: REQ },
  ),

  t(
    'list-filter',
    'proposal.list filters by status',
    async (ctx) => {
      const a = await ctx.proposeOk([op.renameTrack('t-midi', 'A')]);
      const b = await ctx.proposeOk([op.renameTrack('t-audio', 'B')]);
      await ctx.callOk('proposal.reject', { proposalId: b.id });
      const open = await ctx.callOk('proposal.list', { status: ['open'] });
      ctx.same(
        open.proposals.map((p: Loose) => p.id),
        [a.id],
        'open proposals',
      );
      const rejected = await ctx.callOk('proposal.list', { status: ['rejected'] });
      ctx.same(
        rejected.proposals.map((p: Loose) => p.id),
        [b.id],
        'rejected proposals',
      );
      const all = await ctx.callOk('proposal.list', {});
      ctx.equal(all.proposals.length, 2, 'all proposals');
    },
    { requires: REQ },
  ),

  t(
    'accept',
    'accepting a proposal commits it with a proposal receipt',
    async (ctx) => {
      const p = await ctx.proposeOk([op.renameTrack('t-midi', 'Accepted')]);
      const id = ctx.uid('acc');
      const r = await ctx.call('proposal.accept', { proposalId: p.id }, { id });
      const rc = ctx.ok(r, 'accept');
      ctx.equal(rc.kind, 'proposal', 'receipt kind');
      ctx.equal(rc.proposalId, p.id, 'receipt proposalId');
      ctx.equal(rc.transactionId, id, 'transactionId is the accept request id');
      ctx.equal(rc.undoable, true, 'undoable');
      ctx.equal(ctx.track(await ctx.project(), 't-midi').name, 'Accepted', 'state after accept');
      const got = await ctx.callOk('proposal.get', { proposalId: p.id });
      ctx.equal(got.proposal.status, 'accepted', 'status after accept');
      ctx.equal(got.proposal.acceptedRevision, rc.revision, 'acceptedRevision');
    },
    { requires: REQ },
  ),

  t(
    'accept-replay',
    'accepting is idempotent per request id',
    async (ctx) => {
      const p = await ctx.proposeOk([op.renameTrack('t-midi', 'Once')]);
      const id = ctx.uid('acc');
      const base = await ctx.revision();
      const first = await ctx.call('proposal.accept', { proposalId: p.id }, { id, base });
      const rev = await ctx.revision();
      const second = await ctx.call('proposal.accept', { proposalId: p.id }, { id, base });
      ctx.same(second, first, 'replayed accept');
      ctx.equal(await ctx.revision(), rev, 'revision after replay');
    },
    { requires: REQ },
  ),

  t(
    'accept-after-unrelated-change',
    'a proposal still applies after an unrelated commit',
    async (ctx) => {
      const p = await ctx.proposeOk([op.renameTrack('t-audio', 'Proposed')]);
      await ctx.commitOk([op.renameTrack('t-midi', 'Elsewhere')]);
      const rc = ctx.ok(await ctx.call('proposal.accept', { proposalId: p.id }), 'accept');
      ctx.equal(rc.kind, 'proposal', 'kind');
      const project = await ctx.project();
      ctx.equal(ctx.track(project, 't-audio').name, 'Proposed', 'proposed change applied');
      ctx.equal(ctx.track(project, 't-midi').name, 'Elsewhere', 'unrelated change kept');
    },
    { requires: REQ },
  ),

  t(
    'stale',
    'a proposal that conflicts with a later commit is stale and cannot be accepted',
    async (ctx) => {
      const p = await ctx.proposeOk([op.renameTrack('t-midi', 'Mine')]);
      await ctx.commitOk([op.renameTrack('t-midi', 'Theirs')]);
      const before = await ctx.inspect();
      const r = await ctx.call('proposal.accept', { proposalId: p.id });
      ctx.expectError(r, 'proposal_stale', { next: 'reread' });
      await ctx.expectUnchanged(before, 'after stale accept');
      const got = await ctx.callOk('proposal.get', { proposalId: p.id });
      ctx.equal(got.proposal.status, 'stale', 'status');
    },
    { requires: REQ },
  ),

  t(
    'reject-closes',
    'a rejected proposal is closed: it cannot be accepted or rejected again',
    async (ctx) => {
      const p = await ctx.proposeOk([op.renameTrack('t-midi', 'No')]);
      const rej = ctx.ok(await ctx.call('proposal.reject', { proposalId: p.id }), 'reject');
      ctx.equal(rej.status, 'rejected', 'status');
      ctx.expectError(await ctx.call('proposal.accept', { proposalId: p.id }), 'proposal_closed', {
        next: 'reread',
      });
      ctx.expectError(await ctx.call('proposal.reject', { proposalId: p.id }), 'proposal_closed');
      ctx.equal(ctx.track(await ctx.project(), 't-midi').name, 'Keys', 'state untouched');
    },
    { requires: REQ },
  ),

  t(
    'accepted-closes',
    'an accepted proposal cannot be accepted or rejected again',
    async (ctx) => {
      const p = await ctx.proposeOk([op.renameTrack('t-midi', 'Yes')]);
      await ctx.callOk('proposal.accept', { proposalId: p.id });
      ctx.expectError(await ctx.call('proposal.accept', { proposalId: p.id }), 'proposal_closed');
      ctx.expectError(await ctx.call('proposal.reject', { proposalId: p.id }), 'proposal_closed');
    },
    { requires: REQ },
  ),

  t(
    'unknown-id',
    'accepting or rejecting an unknown proposal is not_found',
    async (ctx) => {
      ctx.expectError(await ctx.call('proposal.accept', { proposalId: 'nope' }), 'not_found');
      ctx.expectError(await ctx.call('proposal.reject', { proposalId: 'nope' }), 'not_found');
    },
    { requires: REQ },
  ),

  t(
    'duplicate-id',
    'a proposalId can only be used once',
    async (ctx) => {
      await ctx.proposeOk([op.renameTrack('t-midi', 'A')], { proposalId: 'prop-fixed' });
      const r = await ctx.propose([op.renameTrack('t-midi', 'B')], { proposalId: 'prop-fixed' });
      ctx.expectError(r, 'precondition_failed');
    },
    { requires: REQ },
  ),

  t(
    'invalid-transaction',
    'an invalid transaction does not become a proposal',
    async (ctx) => {
      const r = await ctx.propose([op.renameTrack('ghost', 'x')]);
      ctx.assert(r.status !== 'succeeded', 'proposal.create accepted an invalid transaction');
      ctx.same((await ctx.callOk('proposal.list', {})).proposals, [], 'proposals');
    },
    { requires: REQ },
  ),

  t(
    'propose-then-edit',
    'a propose session creates proposals that an edit session accepts',
    async (ctx) => {
      const p = ctx.ok(
        await ctx.call(
          'proposal.create',
          {
            transaction: { operations: [op.renameTrack('t-midi', 'From proposer')] },
          },
          { client: 0 },
        ),
        'create',
      );
      ctx.expectError(
        await ctx.call('proposal.accept', { proposalId: p.id }, { client: 0 }),
        'not_authorized',
      );
      const rc = ctx.ok(
        await ctx.call('proposal.accept', { proposalId: p.id }, { client: 1 }),
        'accept',
      );
      ctx.equal(rc.kind, 'proposal', 'kind');
      ctx.equal(ctx.track(await ctx.project(1), 't-midi').name, 'From proposer', 'state');
    },
    { requires: REQ, sessions: [{ role: 'propose' }, { role: 'edit' }] },
  ),

  t(
    'not-in-history',
    'a proposal enters history only when accepted',
    async (ctx) => {
      const p = await ctx.proposeOk([op.renameTrack('t-midi', 'H')]);
      ctx.equal((await ctx.callOk('history.list', {})).entries.length, 0, 'history after create');
      await ctx.callOk('proposal.accept', { proposalId: p.id });
      const h = await ctx.callOk('history.list', {});
      ctx.equal(h.entries.length, 1, 'history after accept');
      ctx.equal(h.entries[0].kind, 'proposal', 'entry kind');
    },
    { requires: ['aep.proposals', 'aep.history'] },
  ),

  t(
    'scope-checked-on-create',
    'a scoped session cannot propose changes outside its scope',
    async (ctx) => {
      const ok = await ctx.propose([op.renameClip('c-midi', 'mine')]);
      ctx.equal(ok.status, 'succeeded', 'in-scope proposal');
      const r = await ctx.propose([op.renameClip('c-audio', 'not mine')]);
      ctx.expectError(r, 'scope_violation', { next: 'ask_user' });
    },
    { requires: REQ, sessions: [{ role: 'edit', scope: { clips: ['c-midi'] } }] },
  ),
];
