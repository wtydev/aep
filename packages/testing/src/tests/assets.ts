/**
 * Level `assets`: importing media into the host store and linking it into the project. Requires
 * the standard `inbox` import root (see fixture.ts) and an admin session.
 */
import { INBOX } from '../fixture.js';
import type { Loose } from '../context.js';
import { op } from '../ops.js';
import { ADMIN, defineLevel } from './define.js';

const t = defineLevel('assets');
const REQ = ['aep.audio.assets.import'];

export const assetTests = [
  t(
    'import-wav',
    'asset.import reads a WAV from the inbox and describes it',
    async (ctx) => {
      const { asset } = await ctx.callOk('asset.import', { path: INBOX.wav });
      ctx.assert(typeof asset.id === 'string' && asset.id.length > 0, 'asset id');
      ctx.equal(asset.mediaType, 'audio/wav', 'mediaType');
      ctx.equal(asset.availability, 'available', 'availability');
      ctx.equal(asset.sampleRate, INBOX.wavSampleRate, 'sampleRate');
      ctx.equal(asset.channels, INBOX.wavChannels, 'channels');
      ctx.close(asset.durationSeconds, INBOX.wavSeconds, 'durationSeconds', 0.01);
      ctx.assert(
        /^sha256:[0-9a-f]{64}$/.test(asset.contentHash ?? ''),
        'contentHash must be sha256:<hex>',
      );
      ctx.assert(asset.byteLength > 44, 'byteLength');
    },
    { requires: REQ, sessions: ADMIN },
  ),

  t(
    'import-explicit-id',
    'asset.import honours assetId, and a store id already in use is rejected',
    async (ctx) => {
      const { asset } = await ctx.callOk('asset.import', { path: INBOX.wav, assetId: 'my-tone' });
      ctx.equal(asset.id, 'my-tone', 'asset id');
      ctx.expectError(
        await ctx.call('asset.import', { path: INBOX.wav, assetId: 'my-tone' }),
        'precondition_failed',
      );
    },
    { requires: REQ, sessions: ADMIN },
  ),

  t(
    'not-in-project-until-linked',
    'an imported asset lives in the host store and is not in the project until linked',
    async (ctx) => {
      const before = await ctx.inspect();
      const { asset } = await ctx.callOk('asset.import', { path: INBOX.wav, assetId: 'imp-1' });
      await ctx.expectUnchanged(before, 'after asset.import');
      const store = await ctx.callOk('asset.list', { store: true });
      ctx.assert(
        store.assets.some((a: Loose) => a.id === asset.id),
        'asset missing from the host store',
      );
      const project = await ctx.callOk('asset.list', { store: false });
      ctx.assert(
        !project.assets.some((a: Loose) => a.id === asset.id),
        'asset listed in the project before linking',
      );
      ctx.assert(
        project.assets.some((a: Loose) => a.id === 'a-1'),
        'project asset a-1 missing',
      );
      // An audio clip cannot reference it yet.
      const early = await ctx.commit([
        op.insertAudioClip('t-audio', 'c-early', 10, 1, { assetId: 'imp-1' }),
      ]);
      ctx.expectError(early, 'not_found');
    },
    { requires: REQ, sessions: ADMIN },
  ),

  t(
    'link-and-use',
    'asset.link adds the asset to the project, where clips can use it',
    async (ctx) => {
      const { asset } = await ctx.callOk('asset.import', { path: INBOX.wav, assetId: 'imp-1' });
      const rc = await ctx.commitOk([{ op: 'asset.link', assetId: 'imp-1' }]);
      ctx.assert(
        rc.created.includes('imp-1'),
        `created lacks the asset: ${JSON.stringify(rc.created)}`,
      );
      const p = await ctx.project();
      const linked = p.assets.find((a: Loose) => a.id === 'imp-1');
      ctx.assert(linked, 'asset missing from the project after linking');
      ctx.equal(linked.contentHash, asset.contentHash, 'contentHash survives linking');
      await ctx.commitOk([
        op.insertAudioClip('t-audio', 'c-imp', 10, 1, { assetId: 'imp-1', timebase: 'seconds' }),
      ]);
      ctx.equal(ctx.clip(await ctx.project(), 'c-imp').assetId, 'imp-1', 'clip assetId');
      // Linking twice is an error, and a referenced asset cannot be unlinked.
      const again = await ctx.commit([{ op: 'asset.link', assetId: 'imp-1' }]);
      ctx.expectError(again, 'precondition_failed');
      const unlink = await ctx.commit([{ op: 'asset.unlink', assetId: 'imp-1' }]);
      ctx.expectError(unlink, 'precondition_failed');
    },
    { requires: REQ, sessions: ADMIN },
  ),

  t(
    'link-unlink-roundtrip',
    'a linked asset can be unlinked again and stays in the host store',
    async (ctx) => {
      await ctx.callOk('asset.import', { path: INBOX.wav, assetId: 'imp-2' });
      await ctx.commitOk([{ op: 'asset.link', assetId: 'imp-2' }]);
      await ctx.commitOk([{ op: 'asset.unlink', assetId: 'imp-2' }]);
      ctx.assert(
        !(await ctx.project()).assets.some((a: Loose) => a.id === 'imp-2'),
        'asset still in the project',
      );
      const store = await ctx.callOk('asset.list', { store: true });
      ctx.assert(
        store.assets.some((a: Loose) => a.id === 'imp-2'),
        'asset gone from the store',
      );
      await ctx.commitOk([{ op: 'asset.link', assetId: 'imp-2' }]);
    },
    { requires: REQ, sessions: ADMIN },
  ),

  t(
    'import-does-not-advance-revision',
    'asset.import does not change the project revision',
    async (ctx) => {
      const rev = await ctx.revision();
      const r = await ctx.call('asset.import', { path: INBOX.wav });
      ctx.equal(r.status, 'succeeded', 'import');
      ctx.equal(r.revision, rev, 'result revision');
      ctx.equal(await ctx.revision(), rev, 'revision after import');
    },
    { requires: REQ, sessions: ADMIN },
  ),

  t(
    'import-replay',
    'replaying an import request id returns the identical result and imports once',
    async (ctx) => {
      const id = ctx.uid('imp');
      const first = await ctx.call('asset.import', { path: INBOX.wav }, { id });
      const second = await ctx.call('asset.import', { path: INBOX.wav }, { id });
      ctx.same(second, first, 'replayed import');
      const store = await ctx.callOk('asset.list', { store: true });
      const imported = store.assets.filter((a: Loose) => a.id === (first.output as Loose).asset.id);
      ctx.equal(imported.length, 1, 'store entries for the imported asset');
    },
    { requires: REQ, sessions: ADMIN },
  ),

  t(
    'path-traversal',
    'paths that escape the import root are rejected with path_rejected',
    async (ctx) => {
      for (const path of [
        '../tone.wav',
        'sub/../../tone.wav',
        '/etc/hosts',
        '..',
        './../x.wav',
        'a/../../../etc/passwd',
      ]) {
        const r = await ctx.call('asset.import', { path });
        ctx.assert(r.status !== 'succeeded', `import of '${path}' succeeded`);
        ctx.expectError(r, 'path_rejected', { next: 'fix' });
      }
      const store = await ctx.callOk('asset.list', { store: true });
      ctx.equal(store.assets.length, 0, 'nothing was imported');
    },
    { requires: REQ, sessions: ADMIN },
  ),

  t(
    'unknown-root',
    'an unknown import root is rejected with path_rejected',
    async (ctx) => {
      ctx.expectError(
        await ctx.call('asset.import', { path: INBOX.wav, root: 'no-such-root' }),
        'path_rejected',
        { next: 'fix' },
      );
    },
    { requires: REQ, sessions: ADMIN },
  ),

  t(
    'missing-file',
    'importing a file that does not exist is asset_not_found',
    async (ctx) => {
      ctx.expectError(await ctx.call('asset.import', { path: 'absent.wav' }), 'asset_not_found', {
        next: 'fix',
      });
    },
    { requires: REQ, sessions: ADMIN },
  ),

  t(
    'not-media',
    'a file that is not importable media is invalid_params',
    async (ctx) => {
      const r = await ctx.call('asset.import', { path: INBOX.notMedia });
      ctx.expectError(r, 'invalid_params', { next: 'fix' });
      ctx.equal(
        (await ctx.callOk('asset.list', { store: true })).assets.length,
        0,
        'store stays empty',
      );
    },
    { requires: REQ, sessions: ADMIN },
  ),

  t(
    'no-host-paths',
    'asset descriptions never expose host filesystem paths',
    async (ctx) => {
      const { asset } = await ctx.callOk('asset.import', { path: INBOX.wav });
      const dump = JSON.stringify([asset, await ctx.callOk('asset.list', { store: true })]);
      ctx.assert(
        !/(\/tmp\/|\/var\/|\/Users\/|\/home\/|[A-Z]:\\)/.test(dump),
        'asset output contains a host path',
      );
    },
    { requires: REQ, sessions: ADMIN },
  ),
];
