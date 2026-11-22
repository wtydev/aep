/** Level `core`: envelope, auth, idempotency, revisions, transactions. */
import { ACTIONS, CORE_PROTOCOL, ROLE_ACTIONS } from '@aep/schema';
import type { ActionName } from '@aep/schema';
import type { Loose } from '../context.js';
import { op } from '../ops.js';
import { defineLevel } from './define.js';

const t = defineLevel('core');

export const coreTests = [
  // ------------------------------------------------------------------ envelope
  t(
    'envelope.results-valid',
    'results are valid CoreResults whose output matches the action schema',
    async (ctx) => {
      const actions: [ActionName, Loose][] = [
        ['aep.capabilities', {}],
        ['project.inspect', {}],
        ['project.describe', {}],
        ['transaction.validate', { transaction: { operations: [op.renameTrack('t-midi', 'X')] } }],
      ];
      for (const [action, params] of actions) {
        const r = await ctx.call(action, params);
        ctx.equal(r.status, 'succeeded', `${action} status`);
        ctx.equal(r.protocol, CORE_PROTOCOL, `${action} protocol`);
        ctx.equal(r.session, ctx.client.session, `${action} session echo`);
        ctx.equal(r.workspace, ctx.client.workspace, `${action} workspace echo`);
        const parsed = ACTIONS[action].output.safeParse(r.output);
        ctx.assert(parsed.success, `${action}: output does not match the action output schema`);
      }
      const commit = await ctx.commit([op.renameTrack('t-midi', 'Renamed')]);
      ctx.equal(commit.status, 'succeeded', 'commit status');
      ctx.assert(
        ACTIONS['transaction.commit'].output.safeParse(commit.output).success,
        'commit output invalid',
      );
    },
  ),

  t('envelope.id-echo', 'the result echoes the request id', async (ctx) => {
    const id = ctx.uid('echo');
    const r = await ctx.call('project.describe', {}, { id });
    ctx.equal(r.id, id, 'result id');
  }),

  t('envelope.unknown-action', 'an unknown action is rejected with unknown_action', async (ctx) => {
    const r = await ctx.raw({ action: 'audio.does-not-exist' });
    ctx.expectError(r, 'unknown_action', { next: 'fix' });
  }),

  t('envelope.unsupported-version', 'an unsupported action version is rejected', async (ctx) => {
    const r = await ctx.raw({ action: 'project.inspect', version: 99 });
    ctx.expectError(r, 'unsupported_version', { next: 'fix' });
  }),

  t('envelope.bad-request', 'a malformed envelope is rejected with bad_request', async (ctx) => {
    ctx.expectError(await ctx.raw({ unexpected: true }), 'bad_request');
    ctx.expectError(await ctx.raw({ params: undefined }), 'bad_request');
    ctx.expectError(await ctx.raw({ protocol: 'mep/core/9' }), 'bad_request');
    ctx.expectError(await ctx.raw({ version: 'one' }), 'bad_request');
  }),

  t(
    'envelope.unknown-session',
    'an unknown session is rejected with not_authorized',
    async (ctx) => {
      const r = await ctx.raw({ session: 'no-such-session' });
      ctx.expectError(r, 'not_authorized');
    },
  ),

  t('envelope.workspace-mismatch', 'a request for another workspace is rejected', async (ctx) => {
    const r = await ctx.raw({ workspace: 'some-other-project' });
    ctx.expectError(r, 'not_authorized');
  }),

  t(
    'envelope.invalid-params',
    'params that do not match the action schema give invalid_params',
    async (ctx) => {
      const r = await ctx.call('project.inspect', { surprise: 1 });
      ctx.expectError(r, 'invalid_params', { next: 'fix' });
      const r2 = await ctx.call('transaction.commit', { transaction: { operations: [] } });
      ctx.expectError(r2, 'invalid_params', { next: 'fix' });
      const r3 = await ctx.call('transaction.commit', {
        transaction: { operations: [{ op: 'track.explode', trackId: 't-midi' }] },
      });
      ctx.expectError(r3, 'invalid_params', { next: 'fix' });
    },
  ),

  t('envelope.manifest', 'the session manifest declares actions with schema paths', async (ctx) => {
    const m = ctx.client.manifest;
    if (!m) return ctx.fail('client has no manifest');
    ctx.equal(m.protocol, CORE_PROTOCOL, 'manifest protocol');
    ctx.equal(m.session, ctx.client.session, 'manifest session');
    ctx.equal(m.workspace, ctx.client.workspace, 'manifest workspace');
    const ids = m.actions.map((a) => a.id);
    for (const a of ['aep.capabilities', 'project.inspect', 'transaction.commit']) {
      ctx.assert(ids.includes(a), `manifest lacks ${a}`);
    }
    for (const a of m.actions) {
      ctx.equal(a.effect, ACTIONS[a.id as ActionName]?.effect, `effect of ${a.id}`);
    }
  }),

  t('envelope.capabilities', 'aep.capabilities describes the host', async (ctx) => {
    const caps = await ctx.callOk('aep.capabilities');
    ctx.assert(caps.capabilities['aep.core'], 'aep.core not declared');
    ctx.assert(caps.operations.includes('track.add'), 'track.add not in operations');
    ctx.equal(caps.session.role, 'edit', 'session role');
    for (const [k, v] of Object.entries(caps.limits)) {
      ctx.assert(Number.isInteger(v) && (v as number) > 0, `limit ${k} must be a positive integer`);
    }
    ctx.assert(caps.trackKinds.includes('midi'), 'trackKinds lacks midi');
  }),

  // ------------------------------------------------------------------ auth
  t('auth.bad-credential', 'a wrong credential is rejected with not_authorized', async (ctx) => {
    const r = await ctx.raw({ credential: 'definitely-not-the-credential' });
    ctx.expectError(r, 'not_authorized', { next: 'ask_user' });
  }),

  t(
    'auth.cross-session-credential',
    'one session cannot use another session’s credential',
    async (ctx) => {
      const r = await ctx.raw({ credential: ctx.credential(1) }, { client: 0 });
      ctx.expectError(r, 'not_authorized');
    },
    { sessions: [{ role: 'edit' }, { role: 'edit' }] },
  ),

  t(
    'auth.read-role',
    'a read session can read but not write',
    async (ctx) => {
      ctx.equal((await ctx.call('project.inspect')).status, 'succeeded', 'inspect');
      const before = await ctx.inspect();
      const r = await ctx.commit([op.renameTrack('t-midi', 'Nope')], {}, { base: before.revision });
      ctx.expectError(r, 'not_authorized', { next: 'ask_user' });
      await ctx.expectUnchanged(before);
    },
    { sessions: [{ role: 'read' }] },
  ),

  t(
    'auth.propose-role',
    'a propose session cannot commit or accept',
    async (ctx) => {
      const r = await ctx.commit([op.renameTrack('t-midi', 'Nope')]);
      ctx.expectError(r, 'not_authorized', { next: 'ask_user' });
      ctx.expectError(await ctx.call('history.undo', {}), 'not_authorized');
      ctx.expectError(await ctx.call('proposal.accept', { proposalId: 'p1' }), 'not_authorized');
    },
    { sessions: [{ role: 'propose' }] },
  ),

  t(
    'auth.edit-cannot-import',
    'only admin sessions may import assets',
    async (ctx) => {
      const r = await ctx.call('asset.import', { path: 'tone.wav' });
      ctx.expectError(r, 'not_authorized');
    },
    { requires: ['aep.audio.assets.import'] },
  ),

  t(
    'auth.manifest-filtering',
    'each session’s manifest lists only the actions its role may use',
    async (ctx) => {
      const readIds = new Set(ctx.at(0).manifest?.actions.map((a) => a.id));
      const editIds = new Set(ctx.at(1).manifest?.actions.map((a) => a.id));
      ctx.assert(!readIds.has('transaction.commit'), 'read manifest lists transaction.commit');
      ctx.assert(readIds.has('project.inspect'), 'read manifest lacks project.inspect');
      ctx.assert(editIds.has('transaction.commit'), 'edit manifest lacks transaction.commit');
      for (const id of readIds) {
        ctx.assert(ROLE_ACTIONS.read.has(id as ActionName), `read manifest lists ${id}`);
      }
      for (const id of editIds) {
        ctx.assert(ROLE_ACTIONS.edit.has(id as ActionName), `edit manifest lists ${id}`);
      }
    },
    { sessions: [{ role: 'read' }, { role: 'edit' }] },
  ),

  t(
    'auth.allowed-actions-never-widen',
    'a role grant is enforced on every call, not only advertised',
    async (ctx) => {
      for (const a of ['transaction.commit', 'proposal.accept', 'history.undo', 'asset.import']) {
        const r = await ctx.raw({ action: a, baseRevision: 'rev-0', params: {} });
        ctx.assert(r.status !== 'succeeded', `${a} succeeded for a read session`);
        ctx.expectError(r, 'not_authorized');
      }
    },
    { sessions: [{ role: 'read' }] },
  ),

  // ------------------------------------------------------------------ idempotency
  t(
    'idempotency.replay-identical',
    'repeating a request id returns the identical result without re-executing',
    async (ctx) => {
      const id = ctx.uid('idem');
      const base = await ctx.revision();
      const ops = [op.renameTrack('t-midi', 'Once')];
      const first = await ctx.commit(ops, {}, { id, base });
      ctx.equal(first.status, 'succeeded', 'first commit');
      const second = await ctx.commit(ops, {}, { id, base });
      ctx.same(second, first, 'replayed result');
      const after = await ctx.inspect();
      ctx.equal(after.revision, first.revision, 'revision after replay');
      const rev = Number((first.revision ?? '').replace(/\D/g, ''));
      ctx.equal(
        rev,
        Number(base.replace(/\D/g, '')) + 1,
        'a replay must not create a second revision',
      );
    },
  ),

  t('idempotency.replay-rejected', 'a rejected request replays identically too', async (ctx) => {
    const id = ctx.uid('idem');
    const base = await ctx.revision();
    const ops = [op.renameTrack('no-such-track', 'x')];
    const first = await ctx.commit(ops, {}, { id, base });
    ctx.assert(first.status !== 'succeeded', 'commit on a missing track succeeded');
    const second = await ctx.commit(ops, {}, { id, base });
    ctx.same(second, first, 'replayed rejection');
  }),

  t(
    'idempotency.id-conflict',
    'reusing a request id with different content gives id_conflict',
    async (ctx) => {
      const id = ctx.uid('idem');
      const base = await ctx.revision();
      const a = await ctx.commit([op.renameTrack('t-midi', 'A')], {}, { id, base });
      ctx.equal(a.status, 'succeeded', 'first commit');
      const b = await ctx.commit([op.renameTrack('t-midi', 'B')], {}, { id, base });
      ctx.expectError(b, 'id_conflict', { next: 'fix' });
      const p = await ctx.project();
      ctx.equal(ctx.track(p, 't-midi').name, 'A', 'content after id_conflict');
    },
  ),

  t(
    'idempotency.id-conflict-across-actions',
    'a request id cannot be reused for another action',
    async (ctx) => {
      const id = ctx.uid('idem');
      ctx.equal((await ctx.call('project.describe', {}, { id })).status, 'succeeded', 'describe');
      const r = await ctx.call('project.inspect', {}, { id });
      ctx.expectError(r, 'id_conflict', { next: 'fix' });
    },
  ),

  // ------------------------------------------------------------------ revisions
  t('revisions.advance', 'every commit moves the project to a new revision', async (ctx) => {
    const r0 = await ctx.revision();
    const a = await ctx.commitOk([op.renameTrack('t-midi', 'A')]);
    const b = await ctx.commitOk([op.renameTrack('t-midi', 'B')]);
    ctx.equal(a.baseRevision, r0, 'receipt A baseRevision');
    ctx.equal(b.baseRevision, a.revision, 'receipt B baseRevision');
    ctx.assert(a.revision !== r0 && b.revision !== a.revision, 'revisions did not advance');
    ctx.equal(await ctx.revision(), b.revision, 'current revision');
  }),

  t(
    'revisions.stale-conflict',
    'a stale baseRevision gives conflict (reread), and a reread + retry succeeds',
    async (ctx) => {
      const stale = await ctx.revision();
      await ctx.commitOk([op.renameTrack('t-midi', 'First')]);
      const r = await ctx.commit([op.renameTrack('t-midi', 'Second')], {}, { base: stale });
      ctx.expectError(r, 'conflict', { next: 'reread' });
      ctx.assert(
        r.revision !== undefined && r.revision !== stale,
        'conflict result should carry the current revision',
      );
      ctx.equal(ctx.track(await ctx.project(), 't-midi').name, 'First', 'state after conflict');
      const fresh = await ctx.inspect();
      const ok = await ctx.commit(
        [op.renameTrack('t-midi', 'Second')],
        {},
        { base: fresh.revision },
      );
      ctx.equal(ok.status, 'succeeded', 'retry after reread');
    },
  ),

  t('revisions.missing-base', 'a write without baseRevision is rejected', async (ctx) => {
    const r = await ctx.raw({
      action: 'transaction.commit',
      baseRevision: undefined,
      params: { transaction: { operations: [op.renameTrack('t-midi', 'X')] } },
    });
    ctx.expectError(r, 'invalid_params', { next: 'fix' });
    ctx.equal(ctx.track(await ctx.project(), 't-midi').name, 'Keys', 'state after rejection');
  }),

  t('revisions.unknown-base', 'a baseRevision the host never issued is a conflict', async (ctx) => {
    const r = await ctx.commit([op.renameTrack('t-midi', 'X')], {}, { base: 'rev-999999' });
    ctx.expectError(r, 'conflict', { next: 'reread' });
  }),

  t('revisions.read-needs-no-base', 'reads work without baseRevision', async (ctx) => {
    const r = await ctx.raw({ action: 'project.describe', baseRevision: undefined });
    ctx.equal(r.status, 'succeeded', 'describe without baseRevision');
  }),

  // ------------------------------------------------------------------ transactions
  t('transactions.atomic', 'a failing last operation leaves the project untouched', async (ctx) => {
    const before = await ctx.inspect();
    const r = await ctx.commit([
      op.renameTrack('t-midi', 'Changed'),
      op.addTrack('t-new', 'audio'),
      op.renameTrack('no-such-track', 'boom'),
    ]);
    ctx.assert(r.status !== 'succeeded', 'transaction with a failing operation succeeded');
    ctx.assert(
      ['not_found', 'precondition_failed', 'validation_failed'].includes(r.error?.code ?? ''),
      `unexpected code ${r.error?.code}`,
    );
    await ctx.expectUnchanged(before, 'after failed transaction');
  }),

  t(
    'transactions.validate-no-mutation',
    'transaction.validate never changes the project',
    async (ctx) => {
      const before = await ctx.inspect();
      const v = await ctx.validate([op.renameTrack('t-midi', 'Dry'), op.addTrack('t-dry', 'bus')]);
      const out = ctx.ok(v, 'validate');
      ctx.equal(out.valid, true, 'valid');
      ctx.equal(out.baseRevision, before.revision, 'baseRevision');
      ctx.assert(out.changes.length >= 2, 'validate should report changes');
      await ctx.expectUnchanged(before, 'after validate');
    },
  ),

  t(
    'transactions.validate-reports-failure',
    'transaction.validate reports an invalid transaction as valid:false',
    async (ctx) => {
      const v = await ctx.validate([op.renameTrack('t-midi', 'ok'), op.renameTrack('ghost', 'x')]);
      const out = ctx.ok(v, 'validate');
      ctx.equal(out.valid, false, 'valid');
      ctx.assert(out.diagnostics.length > 0, 'no diagnostics');
      ctx.equal(out.diagnostics[0].operationIndex, 1, 'operationIndex of the failing operation');
      ctx.equal(out.changes.length, 0, 'an invalid transaction reports no changes');
    },
  ),

  t('transactions.receipt-contents', 'the receipt describes the commit', async (ctx) => {
    const id = ctx.uid('rcpt');
    const base = await ctx.revision();
    const r = await ctx.commit(
      [op.renameTrack('t-midi', 'Keys 2'), op.noteUpdate('n1', { velocity: 90 })],
      { label: 'tweak' },
      { id, base },
    );
    const rc = ctx.ok(r, 'commit');
    ctx.equal(rc.transactionId, id, 'transactionId');
    ctx.equal(rc.kind, 'commit', 'kind');
    ctx.equal(rc.projectId, ctx.client.workspace, 'projectId');
    ctx.equal(rc.baseRevision, base, 'baseRevision');
    ctx.equal(rc.revision, r.revision, 'revision');
    ctx.equal(rc.label, 'tweak', 'label');
    ctx.equal(rc.operationCount, 2, 'operationCount');
    ctx.same(rc.operations, ['track.update', 'midi.notes.update'], 'operations');
    ctx.equal(rc.undoable, true, 'undoable');
    const track = rc.changes.find((c: Loose) => c.entity === 'track' && c.kind === 'update');
    ctx.assert(track, 'no track update change');
    ctx.equal(track.path, '/tracks/t-midi', 'track change path');
    ctx.assert(track.fields?.includes('name'), 'track change should list the name field');
    const note = rc.changes.find((c: Loose) => c.entity === 'note');
    ctx.assert(note, 'no note change');
    ctx.equal(note.path, '/tracks/t-midi/clips/c-midi/notes/n1', 'note change path');
    ctx.equal(note.after.velocity, 90, 'note after.velocity');
    ctx.equal(note.before.velocity, 100, 'note before.velocity');
    const got = await ctx.receipt(id);
    ctx.equal(got.status, 'succeeded', 'receipt.get status');
    ctx.same(got.receipt, rc, 'receipt.get receipt');
  }),

  t(
    'transactions.created-and-removed',
    'created and removed entity ids are listed',
    async (ctx) => {
      const rc = await ctx.commitOk([
        op.addTrack('t-new', 'midi'),
        op.insertMidiClip('t-new', 'c-new', 0, 2, { notes: [op.note('nn1')] }),
        { op: 'clip.remove', clipId: 'c-audio' },
      ]);
      ctx.assert(
        rc.created.includes('t-new'),
        `created lacks the track: ${JSON.stringify(rc.created)}`,
      );
      ctx.assert(rc.created.includes('c-new'), 'created lacks the clip');
      ctx.assert(
        rc.removed.includes('c-audio'),
        `removed lacks the clip: ${JSON.stringify(rc.removed)}`,
      );
    },
  ),

  t(
    'transactions.failure-diagnostics',
    'a rejected commit records diagnostics retrievable via receipt.get',
    async (ctx) => {
      const id = ctx.uid('bad');
      const base = await ctx.revision();
      const r = await ctx.commit(
        [op.renameTrack('t-midi', 'fine'), op.renameClip('ghost-clip', 'x')],
        {},
        { id, base },
      );
      ctx.assert(r.status !== 'succeeded', 'commit succeeded');
      const got = await ctx.receipt(id);
      ctx.assert(got.status !== 'succeeded', 'receipt.get status should not be succeeded');
      ctx.equal(got.errorCode, r.error?.code, 'receipt.get errorCode');
      ctx.assert(got.diagnostics.length > 0, 'no diagnostics recorded');
      ctx.equal(got.diagnostics[0].operationIndex, 1, 'operationIndex');
      ctx.equal(got.receipt, undefined, 'a rejected commit has no receipt');
    },
  ),

  t(
    'transactions.receipt-unknown',
    'receipt.get for an unknown request is not_found',
    async (ctx) => {
      ctx.expectError(await ctx.call('receipt.get', { requestId: 'never-sent' }), 'not_found', {
        next: 'reread',
      });
    },
  ),

  t(
    'transactions.ops-apply-in-order',
    'operations in one transaction see the effect of earlier ones',
    async (ctx) => {
      await ctx.commitOk([
        op.addTrack('t-seq', 'midi'),
        op.insertMidiClip('t-seq', 'c-seq', 0, 2),
        { op: 'midi.notes.add', clipId: 'c-seq', notes: [op.note('s1', 64)] },
        { op: 'clip.move', clipId: 'c-seq', start: 8 },
      ]);
      const p = await ctx.project();
      const clip = ctx.clip(p, 'c-seq');
      ctx.equal(clip.start, 8, 'clip start');
      ctx.equal(clip.notes.length, 1, 'note count');
    },
  ),

  t(
    'transactions.describe-counts',
    'project.describe reports counts of the fixture',
    async (ctx) => {
      const d = await ctx.callOk('project.describe');
      ctx.equal(d.projectId, ctx.client.workspace, 'projectId');
      ctx.equal(d.trackCount, 3, 'trackCount');
      ctx.equal(d.clipCount, 2, 'clipCount');
      ctx.equal(d.noteCount, 8, 'noteCount');
      ctx.equal(d.assetCount, 1, 'assetCount');
      ctx.close(d.durationBeats, 8, 'durationBeats');
      ctx.close(d.durationSeconds, 4, 'durationSeconds');
    },
  ),

  t(
    'transactions.state-matches-inspect',
    'the transport state document matches project.inspect',
    async (ctx) => {
      const tr = ctx.client.transport as { state?: () => Promise<Loose> };
      if (typeof tr.state !== 'function') return ctx.skip('transport exposes no state document');
      const state = await tr.state();
      const inspect = await ctx.inspect();
      ctx.equal(state.revision, inspect.revision, 'state revision');
      ctx.same(state.data, inspect.project, 'state data');
    },
  ),
];
