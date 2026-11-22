/** Level `security`: scope enforcement, credential hygiene and resource limits. */
import type { Loose } from '../context.js';
import { op } from '../ops.js';
import { defineLevel } from './define.js';

const t = defineLevel('security');
const clipScoped = [{ role: 'edit' as const, scope: { clips: ['c-midi'] } }];

export const securityTests = [
  // ------------------------------------------------------------------ scope
  t(
    'scope.clip',
    'a clip-scoped session cannot edit other clips; the violation is diagnosed',
    async (ctx) => {
      ctx.equal(
        (await ctx.commit([op.renameClip('c-midi', 'Mine')])).status,
        'succeeded',
        'in-scope commit',
      );
      ctx.equal(
        (await ctx.commit([op.noteUpdate('n1', { velocity: 77 })])).status,
        'succeeded',
        'notes of the scoped clip',
      );
      const before = await ctx.inspect();
      const id = ctx.uid('viol');
      const r = await ctx.commit(
        [op.renameClip('c-audio', 'Not mine')],
        {},
        { id, base: before.revision },
      );
      ctx.expectError(r, 'scope_violation', { next: 'ask_user' });
      await ctx.expectUnchanged(before, 'after scope violation');
      const rec = await ctx.receipt(id);
      ctx.equal(rec.errorCode, 'scope_violation', 'receipt errorCode');
      ctx.assert(
        rec.diagnostics.some((d: Loose) => d.code === 'scope_violation'),
        'receipt lacks a scope_violation diagnostic',
      );
    },
    { sessions: clipScoped },
  ),

  t(
    'scope.clip-no-structure',
    'a clip-scoped session cannot add or remove tracks and clips elsewhere',
    async (ctx) => {
      ctx.expectError(await ctx.commit([op.addTrack('t-new', 'audio')]), 'scope_violation');
      ctx.expectError(
        await ctx.commit([{ op: 'clip.remove', clipId: 'c-audio' }]),
        'scope_violation',
      );
      ctx.expectError(await ctx.commit([{ op: 'clip.move', clipId: 'c-midi', trackId: 't-new' }]), [
        'scope_violation',
        'not_found',
      ]);
    },
    { sessions: clipScoped },
  ),

  t(
    'scope.track',
    'a track-scoped session cannot touch other tracks or project-level data',
    async (ctx) => {
      ctx.equal(
        (await ctx.commit([op.renameClip('c-midi', 'ok')])).status,
        'succeeded',
        'in-scope commit',
      );
      ctx.expectError(await ctx.commit([op.renameClip('c-audio', 'no')]), 'scope_violation');
      ctx.expectError(
        await ctx.commit([{ op: 'tempo.update', tempo: [{ beat: 0, bpm: 90 }] }]),
        'scope_violation',
      );
      ctx.expectError(
        await ctx.commit([{ op: 'project.update', patch: { name: 'x' } }]),
        'scope_violation',
      );
      ctx.expectError(
        await ctx.commit([{ op: 'section.remove', sectionId: 's-1' }]),
        'scope_violation',
      );
    },
    { sessions: [{ role: 'edit', scope: { tracks: ['t-midi'] } }] },
  ),

  t(
    'scope.time-range',
    'a timeRange scope rejects changes outside the range, including indirect effects',
    async (ctx) => {
      ctx.equal(
        (await ctx.commit([op.noteUpdate('n1', { velocity: 90 })])).status,
        'succeeded',
        'edit inside the range',
      );
      const before = await ctx.inspect();
      // Moving the 4-beat clip to beat 2 drags it (and its notes) to 2..6, outside 0..4.
      ctx.expectError(
        await ctx.commit(
          [{ op: 'clip.move', clipId: 'c-midi', start: 2 }],
          {},
          { base: before.revision },
        ),
        'scope_violation',
      );
      // c-audio lives at 4..8: entirely outside.
      ctx.expectError(await ctx.commit([op.renameClip('c-audio', 'x')]), 'scope_violation');
      // Extending a clip past the range end.
      ctx.expectError(
        await ctx.commit([{ op: 'clip.update', clipId: 'c-midi', patch: { duration: 6 } }]),
        'scope_violation',
      );
      await ctx.expectUnchanged(
        { revision: (await ctx.inspect()).revision, project: (await ctx.inspect()).project },
        'state',
      );
    },
    { sessions: [{ role: 'edit', scope: { timeRange: { start: 0, end: 4, unit: 'beats' } } }] },
  ),

  t(
    'scope.operations',
    'an operations scope allows only the listed operations (wildcards supported)',
    async (ctx) => {
      ctx.equal(
        (await ctx.commit([op.noteUpdate('n1', { pitch: 62 })])).status,
        'succeeded',
        'midi.notes.update',
      );
      ctx.equal(
        (
          await ctx.commit([
            { op: 'midi.notes.add', clipId: 'c-midi', notes: [op.note('n20', 70, 1)] },
          ])
        ).status,
        'succeeded',
        'midi.notes.add',
      );
      ctx.expectError(await ctx.commit([op.renameClip('c-midi', 'x')]), 'scope_violation');
      ctx.expectError(await ctx.commit([op.renameTrack('t-midi', 'x')]), 'scope_violation');
    },
    { sessions: [{ role: 'edit', scope: { operations: ['midi.notes.*'] } }] },
  ),

  t(
    'scope.operations-exact',
    'an exact operation name in scope does not allow its siblings',
    async (ctx) => {
      ctx.equal(
        (await ctx.commit([op.renameTrack('t-midi', 'ok')])).status,
        'succeeded',
        'track.update',
      );
      ctx.expectError(
        await ctx.commit([{ op: 'track.remove', trackId: 't-midi' }]),
        'scope_violation',
      );
      ctx.expectError(await ctx.commit([op.addTrack('t-new', 'bus')]), 'scope_violation');
    },
    { sessions: [{ role: 'edit', scope: { operations: ['track.update'] } }] },
  ),

  t(
    'scope.properties',
    'a properties scope allows changing only the listed fields',
    async (ctx) => {
      ctx.equal(
        (await ctx.commit([op.renameTrack('t-midi', 'Named')])).status,
        'succeeded',
        'name',
      );
      ctx.equal(
        (await ctx.commit([op.renameClip('c-midi', 'Named')])).status,
        'succeeded',
        'clip name',
      );
      ctx.expectError(
        await ctx.commit([{ op: 'track.update', trackId: 't-midi', patch: { gainDb: -3 } }]),
        'scope_violation',
      );
      ctx.expectError(await ctx.commit([op.noteUpdate('n1', { pitch: 70 })]), 'scope_violation');
    },
    { sessions: [{ role: 'edit', scope: { properties: ['name'] } }] },
  ),

  t(
    'scope.transaction-narrows',
    'a transaction scope narrows the session scope',
    async (ctx) => {
      const ok = await ctx.commit([op.renameClip('c-audio', 'ok')], {
        scope: { clips: ['c-audio'] },
      });
      ctx.equal(ok.status, 'succeeded', 'inside both scopes');
      const before = await ctx.inspect();
      const narrow = await ctx.commit(
        [op.renameClip('c-midi', 'nope')],
        { scope: { clips: ['c-audio'] } },
        { base: before.revision },
      );
      ctx.expectError(narrow, 'scope_violation');
      await ctx.expectUnchanged(before, 'after narrowed violation');
    },
    { sessions: [{ role: 'edit', scope: { tracks: ['t-midi', 't-audio'] } }] },
  ),

  t(
    'scope.transaction-cannot-widen',
    'a transaction scope cannot widen the session scope',
    async (ctx) => {
      const r = await ctx.commit([op.renameClip('c-audio', 'sneaky')], {
        scope: { clips: ['c-audio', 'c-midi'] },
      });
      ctx.expectError(r, 'scope_violation');
    },
    { sessions: clipScoped },
  ),

  t(
    'scope.unscoped-transaction',
    'an unscoped session may narrow itself with a transaction scope',
    async (ctx) => {
      const r = await ctx.commit([op.renameClip('c-midi', 'x'), op.renameClip('c-audio', 'y')], {
        scope: { clips: ['c-midi'] },
      });
      ctx.expectError(r, 'scope_violation');
      const ok = await ctx.commit([op.renameClip('c-midi', 'x')], { scope: { clips: ['c-midi'] } });
      ctx.equal(ok.status, 'succeeded', 'in-scope');
    },
  ),

  t(
    'scope.validate',
    'transaction.validate reports scope violations as valid:false',
    async (ctx) => {
      const out = ctx.ok(await ctx.validate([op.renameClip('c-audio', 'x')]), 'validate');
      ctx.equal(out.valid, false, 'valid');
      ctx.assert(
        out.diagnostics.some((d: Loose) => d.code === 'scope_violation'),
        'no scope_violation diagnostic',
      );
      const fine = ctx.ok(await ctx.validate([op.renameClip('c-midi', 'x')]), 'validate');
      ctx.equal(fine.valid, true, 'in-scope transaction is valid');
    },
    { sessions: clipScoped },
  ),

  t(
    'scope.reads-unfiltered',
    'a scoped session can still read the whole project',
    async (ctx) => {
      const p = await ctx.project();
      ctx.equal(p.tracks.length, 3, 'tracks visible');
      ctx.assert(ctx.hasClip(p, 'c-audio'), 'out-of-scope clip visible');
      const caps = await ctx.callOk('aep.capabilities');
      ctx.same(caps.session.scope, { clips: ['c-midi'] }, 'the granted scope is advertised');
    },
    { sessions: clipScoped },
  ),

  t(
    'scope.undo',
    'undo is checked against the undoing session’s scope',
    async (ctx) => {
      ctx.equal(
        (
          await ctx.call(
            'transaction.commit',
            { transaction: { operations: [op.renameClip('c-audio', 'by admin')] } },
            { client: 0 },
          )
        ).status,
        'succeeded',
        'unscoped commit',
      );
      const before = await ctx.inspect(1);
      const r = await ctx.call('history.undo', {}, { client: 1 });
      ctx.expectError(r, 'scope_violation');
      await ctx.expectUnchanged(before, 'after scoped undo');
      ctx.equal(
        (await ctx.call('history.undo', {}, { client: 0 })).status,
        'succeeded',
        'the unscoped session can undo',
      );
    },
    {
      requires: ['aep.history'],
      sessions: [{ role: 'edit' }, { role: 'edit', scope: { clips: ['c-midi'] } }],
    },
  ),

  t(
    'scope.accept',
    'accepting a proposal is checked against the accepting session’s scope',
    async (ctx) => {
      const p = ctx.ok(
        await ctx.call(
          'proposal.create',
          { transaction: { operations: [op.renameClip('c-audio', 'prop')] } },
          { client: 0 },
        ),
        'create',
      );
      const r = await ctx.call('proposal.accept', { proposalId: p.id }, { client: 1 });
      ctx.expectError(r, 'scope_violation');
      const got = await ctx.callOk('proposal.get', { proposalId: p.id }, { client: 0 });
      ctx.equal(got.proposal.status, 'open', 'the proposal stays open');
      ctx.equal(
        (await ctx.call('proposal.accept', { proposalId: p.id }, { client: 0 })).status,
        'succeeded',
        'unscoped accept',
      );
    },
    {
      requires: ['aep.proposals'],
      sessions: [{ role: 'edit' }, { role: 'edit', scope: { clips: ['c-midi'] } }],
    },
  ),

  // ------------------------------------------------------------------ credentials
  t('credential.not-echoed', 'the credential never appears in any output', async (ctx) => {
    const credential = ctx.credential();
    const wrong = 'wrong-credential-MARKER-0123456789';
    const outputs: unknown[] = [];
    const keep = (r: unknown): void => {
      outputs.push(r);
    };
    keep(ctx.client.manifest);
    keep(await ctx.client.transport.manifest());
    keep(await ctx.client.transport.state());
    keep(await ctx.call('aep.capabilities'));
    keep(await ctx.call('project.inspect'));
    keep(await ctx.call('project.describe'));
    const id = ctx.uid('sec');
    keep(await ctx.commit([op.renameTrack('t-midi', 'sec')], {}, { id }));
    keep(await ctx.call('receipt.get', { requestId: id }));
    keep(await ctx.commit([op.renameTrack('ghost', 'x')]));
    keep(await ctx.raw({ credential: wrong }));
    keep(await ctx.raw({ credential: wrong, action: 'nope.nope' }));
    keep(await ctx.raw({ credential: wrong, unexpected: 1 }));
    keep(await ctx.raw({ action: 'no.such-action' }));
    keep(await ctx.raw({ params: undefined }));
    if (ctx.has('aep.history')) keep(await ctx.call('history.list', {}));
    if (ctx.has('aep.proposals')) keep(await ctx.call('proposal.list', {}));
    const dump = JSON.stringify(outputs);
    ctx.assert(!dump.includes(credential), 'an output contains the session credential');
    ctx.assert(!dump.includes(wrong), 'an output echoes a credential that was sent in a request');
  }),

  t(
    'credential.bad-credential-leaves-no-trace',
    'a request with a bad credential has no effect and does not burn its id',
    async (ctx) => {
      const id = ctx.uid('trace');
      const base = await ctx.revision();
      const params = { transaction: { operations: [op.renameTrack('t-midi', 'Evil')] } };
      const bad = await ctx.raw({
        action: 'transaction.commit',
        id,
        baseRevision: base,
        params,
        credential: 'not-the-credential',
      });
      ctx.expectError(bad, 'not_authorized');
      ctx.equal(await ctx.revision(), base, 'revision after a rejected request');
      // The same id with the right credential must work: failed authentication is not recorded.
      const good = await ctx.raw({ action: 'transaction.commit', id, baseRevision: base, params });
      ctx.equal(
        good.status,
        'succeeded',
        `legitimate request with the same id (${JSON.stringify(good.error ?? '')})`,
      );
    },
  ),

  t('credential.expiry-advertised', 'the session declares an expiry in the future', async (ctx) => {
    const caps = await ctx.callOk('aep.capabilities');
    ctx.assert(Number.isInteger(caps.session.expiresAt), 'expiresAt must be an integer');
    ctx.assert(caps.session.expiresAt > Date.now(), 'the session is already expired');
    ctx.equal(
      ctx.client.manifest?.expiresAt,
      caps.session.expiresAt,
      'manifest and capabilities agree on expiresAt',
    );
  }),

  // ------------------------------------------------------------------ limits
  t(
    'limits.advertised',
    'limits are advertised as positive integers and are enforced consistently',
    async (ctx) => {
      const { limits } = await ctx.callOk('aep.capabilities');
      for (const k of [
        'maxOperationsPerTransaction',
        'maxRequestBytes',
        'maxNotesPerClip',
        'maxTracks',
        'maxOpenProposals',
        'receiptRetention',
      ]) {
        ctx.assert(Number.isInteger(limits[k]) && limits[k] > 0, `limit ${k} = ${limits[k]}`);
      }
      ctx.assert(limits.maxRequestBytes >= 1024, 'maxRequestBytes is unusably small');
      ctx.assert(limits.maxOperationsPerTransaction >= 1, 'maxOperationsPerTransaction');
    },
  ),

  t(
    'limits.operations-per-transaction',
    'a transaction with too many operations is rejected',
    async (ctx) => {
      const { limits } = await ctx.callOk('aep.capabilities');
      const n = limits.maxOperationsPerTransaction;
      if (n > 5000) ctx.skip(`maxOperationsPerTransaction (${n}) is too large to probe`);
      const ops = Array.from({ length: n + 1 }, (_, i) => op.renameTrack('t-midi', `n${i}`));
      const before = await ctx.inspect();
      const r = await ctx.commit(ops, {}, { base: before.revision });
      ctx.expectError(r, ['limit_exceeded', 'invalid_params'], { next: 'fix' });
      await ctx.expectUnchanged(before, 'after over-limit commit');
      const atLimit = await ctx.commit(ops.slice(0, n));
      ctx.equal(atLimit.status, 'succeeded', 'a transaction at the limit is accepted');
    },
  ),

  t('limits.request-bytes', 'an oversized request is rejected with limit_exceeded', async (ctx) => {
    const { limits } = await ctx.callOk('aep.capabilities');
    if (limits.maxRequestBytes > 4 * 1024 * 1024)
      ctx.skip(`maxRequestBytes (${limits.maxRequestBytes}) is too large to probe`);
    const r = await ctx.raw({
      action: 'project.inspect',
      params: { padding: 'x'.repeat(limits.maxRequestBytes + 16) },
    });
    ctx.expectError(r, 'limit_exceeded', { next: 'fix' });
    ctx.equal(
      (await ctx.call('project.describe')).status,
      'succeeded',
      'the host still serves requests',
    );
  }),

  t('limits.tracks', 'the track limit is enforced', async (ctx) => {
    const { limits } = await ctx.callOk('aep.capabilities');
    const room = limits.maxTracks - 3;
    if (limits.maxTracks > 600 || room + 1 > limits.maxOperationsPerTransaction)
      ctx.skip('maxTracks is too large to probe in one transaction');
    const add = (count: number): Loose[] =>
      Array.from({ length: count }, (_, i) => op.addTrack(`bulk-${i}`, 'audio'));
    const before = await ctx.inspect();
    ctx.expectError(
      await ctx.commit(add(room + 1), {}, { base: before.revision }),
      ['limit_exceeded', 'precondition_failed'],
      { next: 'fix' },
    );
    await ctx.expectUnchanged(before, 'after over-limit commit');
    ctx.equal(
      (await ctx.commit(add(room))).status,
      'succeeded',
      'filling the project to the limit',
    );
  }),

  t(
    'limits.open-proposals',
    'the open-proposal limit is enforced',
    async (ctx) => {
      const { limits } = await ctx.callOk('aep.capabilities');
      const n = limits.maxOpenProposals;
      if (n > 100) ctx.skip(`maxOpenProposals (${n}) is too large to probe`);
      for (let i = 0; i < n; i++) await ctx.proposeOk([op.renameTrack('t-midi', `p${i}`)]);
      const r = await ctx.propose([op.renameTrack('t-midi', 'over')]);
      ctx.expectError(r, 'limit_exceeded', { next: 'fix' });
    },
    { requires: ['aep.proposals'] },
  ),
];
