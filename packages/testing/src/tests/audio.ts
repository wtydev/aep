/**
 * Level `audio`: the audio-domain operations and their normative semantics
 * (specs/audio/AUDIO-DOMAIN.md). Fixture: 120 bpm, c-midi 0..4 beats with n1..n8, c-audio 4..8
 * beats with sourceOffset 1 s.
 */
import type { Loose, TestContext } from '../context.js';
import { op } from '../ops.js';
import { defineLevel } from './define.js';

const t = defineLevel('audio');

/** Commit must be rejected with one of `codes`, and must leave the project untouched. */
async function rejects(ctx: TestContext, ops: Loose[], codes: string | string[]): Promise<void> {
  const before = await ctx.inspect();
  const r = await ctx.commit(ops, {}, { base: before.revision });
  ctx.expectError(r, codes);
  await ctx.expectUnchanged(before, 'after rejected commit');
}

export const audioTests = [
  // ------------------------------------------------------------------ tracks
  t('tracks.add', 'track.add inserts at an index (clamped) and applies defaults', async (ctx) => {
    await ctx.commitOk([
      op.addTrack('t-first', 'audio', {}, 0),
      op.addTrack('t-last', 'midi', {}, 500),
    ]);
    const p = await ctx.project();
    ctx.same(ctx.trackIds(p), ['t-first', 't-midi', 't-audio', 't-bus', 't-last'], 'track order');
    const added = ctx.track(p, 't-first');
    ctx.equal(added.mute, false, 'default mute');
    ctx.equal(added.output, 'master', 'default output');
    ctx.equal(added.gainDb, 0, 'default gainDb');
    ctx.same(added.clips, [], 'default clips');
  }),

  t('tracks.add-duplicate', 'track.add with an existing id is rejected', async (ctx) => {
    await rejects(ctx, [op.addTrack('t-midi', 'audio')], 'precondition_failed');
  }),

  t(
    'tracks.update',
    'track.update patches properties; unknown fields are invalid_params',
    async (ctx) => {
      await ctx.commitOk([
        {
          op: 'track.update',
          trackId: 't-audio',
          patch: { name: 'Vox', gainDb: -6, pan: 0.5, mute: true },
        },
      ]);
      const tr = ctx.track(await ctx.project(), 't-audio');
      ctx.equal(tr.name, 'Vox', 'name');
      ctx.equal(tr.gainDb, -6, 'gainDb');
      ctx.equal(tr.pan, 0.5, 'pan');
      ctx.equal(tr.mute, true, 'mute');
      ctx.equal(tr.kind, 'audio', 'untouched kind');
      const bad = await ctx.commit([
        { op: 'track.update', trackId: 't-audio', patch: { id: 'new-id' } },
      ]);
      ctx.expectError(bad, 'invalid_params');
      ctx.expectError(
        await ctx.commit([{ op: 'track.update', trackId: 'ghost', patch: { name: 'x' } }]),
        'not_found',
      );
    },
  ),

  t(
    'tracks.remove',
    'track.remove deletes the track with its clips; missing → not_found',
    async (ctx) => {
      await ctx.commitOk([{ op: 'track.remove', trackId: 't-midi' }]);
      const p = await ctx.project();
      ctx.same(ctx.trackIds(p), ['t-audio', 't-bus'], 'remaining tracks');
      ctx.assert(!ctx.hasClip(p, 'c-midi'), 'clip of the removed track survived');
      await rejects(ctx, [{ op: 'track.remove', trackId: 'ghost' }], 'not_found');
    },
  ),

  t('tracks.remove-referenced', 'a track other tracks route to cannot be removed', async (ctx) => {
    await rejects(ctx, [{ op: 'track.remove', trackId: 't-bus' }], 'precondition_failed');
    await ctx.commitOk([
      { op: 'routing.update', trackId: 't-audio', output: 'master' },
      { op: 'track.remove', trackId: 't-bus' },
    ]);
    ctx.same(ctx.trackIds(await ctx.project()), ['t-midi', 't-audio'], 'tracks after unrouting');
  }),

  t('tracks.reorder', 'track.reorder moves a track and clamps the index', async (ctx) => {
    await ctx.commitOk([{ op: 'track.reorder', trackId: 't-bus', index: 0 }]);
    ctx.same(
      ctx.trackIds(await ctx.project()),
      ['t-bus', 't-midi', 't-audio'],
      'after move to front',
    );
    await ctx.commitOk([{ op: 'track.reorder', trackId: 't-bus', index: 99 }]);
    ctx.same(
      ctx.trackIds(await ctx.project()),
      ['t-midi', 't-audio', 't-bus'],
      'after move past the end',
    );
    await rejects(ctx, [{ op: 'track.reorder', trackId: 'ghost', index: 0 }], 'not_found');
  }),

  t(
    'tracks.kind-compat',
    'audio clips go on audio/hybrid tracks, MIDI clips on midi/instrument/hybrid',
    async (ctx) => {
      await ctx.commitOk([
        op.addTrack('t-mid2', 'midi'),
        op.addTrack('t-hyb', 'hybrid'),
        op.addTrack('t-aud2', 'audio'),
      ]);
      await ctx.commitOk([
        op.insertMidiClip('t-mid2', 'k1'),
        op.insertMidiClip('t-hyb', 'k2'),
        op.insertMidiClip('t-midi', 'k3', 8),
        op.insertAudioClip('t-hyb', 'k4', 8),
        op.insertAudioClip('t-aud2', 'k5'),
      ]);
      await rejects(ctx, [op.insertAudioClip('t-midi', 'bad1')], 'precondition_failed');
      await rejects(ctx, [op.insertAudioClip('t-mid2', 'bad2')], 'precondition_failed');
      await rejects(ctx, [op.insertMidiClip('t-aud2', 'bad3')], 'precondition_failed');
      await rejects(ctx, [op.insertMidiClip('t-bus', 'bad4')], 'precondition_failed');
      await rejects(ctx, [op.insertAudioClip('t-bus', 'bad5')], 'precondition_failed');
    },
  ),

  t(
    'tracks.parent-invalid',
    'a track cannot be its own parent or have a missing parent',
    async (ctx) => {
      await rejects(
        ctx,
        [{ op: 'track.update', trackId: 't-midi', patch: { parentId: 't-midi' } }],
        ['precondition_failed', 'validation_failed'],
      );
      await rejects(
        ctx,
        [{ op: 'track.update', trackId: 't-midi', patch: { parentId: 'ghost' } }],
        ['not_found', 'precondition_failed', 'validation_failed'],
      );
    },
  ),

  // ------------------------------------------------------------------ clips
  t(
    'clips.insert',
    'clip.insert adds a clip; duplicate ids and unknown tracks are rejected',
    async (ctx) => {
      const rc = await ctx.commitOk([op.insertMidiClip('t-midi', 'c-new', 8, 2, { name: 'New' })]);
      ctx.assert(rc.created.includes('c-new'), 'created id missing');
      const c = ctx.clip(await ctx.project(), 'c-new');
      ctx.equal(c.start, 8, 'start');
      ctx.equal(c.duration, 2, 'duration');
      ctx.equal(c.type, 'midi', 'type');
      ctx.same(c.notes, [], 'default notes');
      await rejects(ctx, [op.insertMidiClip('t-midi', 'c-midi', 20)], 'precondition_failed');
      await rejects(ctx, [op.insertMidiClip('ghost', 'c-x')], 'not_found');
    },
  ),

  t(
    'clips.insert-asset-ref',
    'an audio clip must reference an asset that is in the project',
    async (ctx) => {
      await rejects(
        ctx,
        [op.insertAudioClip('t-audio', 'c-ghost', 10, 1, { assetId: 'no-such-asset' })],
        'not_found',
      );
      await ctx.commitOk([op.insertAudioClip('t-audio', 'c-ok', 10, 1)]);
    },
  ),

  t('clips.move', 'clip.move changes start and/or track', async (ctx) => {
    await ctx.commitOk([{ op: 'clip.move', clipId: 'c-midi', start: 6 }]);
    ctx.equal(ctx.clip(await ctx.project(), 'c-midi').start, 6, 'start');
    await ctx.commitOk([
      op.addTrack('t-m2', 'midi'),
      { op: 'clip.move', clipId: 'c-midi', trackId: 't-m2' },
    ]);
    const p = await ctx.project();
    ctx.equal(ctx.trackOfClip(p, 'c-midi').id, 't-m2', 'track after move');
    ctx.equal(ctx.clip(p, 'c-midi').start, 6, 'start kept when only the track changes');
    await rejects(
      ctx,
      [{ op: 'clip.move', clipId: 'c-audio', trackId: 't-m2' }],
      'precondition_failed',
    );
    await rejects(ctx, [{ op: 'clip.move', clipId: 'ghost', start: 1 }], 'not_found');
  }),

  t(
    'clips.update',
    'clip.update patches common and type-specific fields; null clears',
    async (ctx) => {
      await ctx.commitOk([
        {
          op: 'clip.update',
          clipId: 'c-audio',
          patch: {
            name: 'Take 2',
            gainDb: -3,
            muted: true,
            fadeIn: { duration: 0.5, curve: 'linear' },
            fadeOut: { duration: 1, curve: 'equal-power' },
            sourceOffset: 2,
            playbackRate: 2,
          },
        },
      ]);
      let c = ctx.clip(await ctx.project(), 'c-audio');
      ctx.equal(c.name, 'Take 2', 'name');
      ctx.equal(c.gainDb, -3, 'gainDb');
      ctx.equal(c.muted, true, 'muted');
      ctx.equal(c.fadeIn.duration, 0.5, 'fadeIn');
      ctx.equal(c.fadeOut.curve, 'equal-power', 'fadeOut');
      ctx.equal(c.sourceOffset, 2, 'sourceOffset');
      ctx.equal(c.playbackRate, 2, 'playbackRate');
      await ctx.commitOk([
        { op: 'clip.update', clipId: 'c-audio', patch: { fadeIn: null, fadeOut: null } },
      ]);
      c = ctx.clip(await ctx.project(), 'c-audio');
      ctx.assert(c.fadeIn === undefined && c.fadeOut === undefined, 'null did not clear the fades');
    },
  ),

  t(
    'clips.update-type-specific',
    'audio-only and MIDI-only fields are rejected on the wrong clip type',
    async (ctx) => {
      await rejects(
        ctx,
        [{ op: 'clip.update', clipId: 'c-midi', patch: { sourceOffset: 1 } }],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [{ op: 'clip.update', clipId: 'c-midi', patch: { playbackRate: 2 } }],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [{ op: 'clip.update', clipId: 'c-audio', patch: { offset: 1 } }],
        'precondition_failed',
      );
    },
  ),

  t('clips.remove', 'clip.remove deletes the clip; missing → not_found', async (ctx) => {
    const rc = await ctx.commitOk([{ op: 'clip.remove', clipId: 'c-midi' }]);
    ctx.assert(rc.removed.includes('c-midi'), 'removed id missing');
    ctx.assert(!ctx.hasClip(await ctx.project(), 'c-midi'), 'clip still present');
    await rejects(ctx, [{ op: 'clip.remove', clipId: 'c-midi' }], 'not_found');
  }),

  t(
    'clips.trim-start-audio',
    'clip.trim(start) on an audio clip advances sourceOffset by the trimmed time',
    async (ctx) => {
      // 120 bpm: 1 beat = 0.5 s. Start 4→5 trims 0.5 s of source: sourceOffset 1 → 1.5.
      await ctx.commitOk([{ op: 'clip.trim', clipId: 'c-audio', edge: 'start', to: 5 }]);
      const c = ctx.clip(await ctx.project(), 'c-audio');
      ctx.equal(c.start, 5, 'start');
      ctx.close(c.duration, 3, 'duration');
      ctx.close(c.sourceOffset, 1.5, 'sourceOffset');
      // The clip end stays at beat 8.
      ctx.close(c.start + c.duration, 8, 'end');
    },
  ),

  t(
    'clips.trim-start-audio-rate',
    'clip.trim(start) scales the source advance by playbackRate',
    async (ctx) => {
      await ctx.commitOk([{ op: 'clip.update', clipId: 'c-audio', patch: { playbackRate: 2 } }]);
      await ctx.commitOk([{ op: 'clip.trim', clipId: 'c-audio', edge: 'start', to: 5 }]);
      const c = ctx.clip(await ctx.project(), 'c-audio');
      ctx.close(c.sourceOffset, 2, 'sourceOffset (1 + 0.5 s × rate 2)');
    },
  ),

  t(
    'clips.trim-start-before-source',
    'trimming an audio clip start before the start of its source is rejected',
    async (ctx) => {
      // Extending to beat 0 would need sourceOffset 1 − 2 s < 0.
      await rejects(
        ctx,
        [{ op: 'clip.trim', clipId: 'c-audio', edge: 'start', to: 0 }],
        'precondition_failed',
      );
    },
  ),

  t('clips.trim-end', 'clip.trim(end) changes the duration only', async (ctx) => {
    await ctx.commitOk([{ op: 'clip.trim', clipId: 'c-audio', edge: 'end', to: 6 }]);
    const c = ctx.clip(await ctx.project(), 'c-audio');
    ctx.equal(c.start, 4, 'start');
    ctx.close(c.duration, 2, 'duration');
    ctx.close(c.sourceOffset, 1, 'sourceOffset');
    await rejects(
      ctx,
      [{ op: 'clip.trim', clipId: 'c-audio', edge: 'end', to: 4 }],
      'precondition_failed',
    );
    await rejects(
      ctx,
      [{ op: 'clip.trim', clipId: 'c-audio', edge: 'start', to: 6 }],
      'precondition_failed',
    );
  }),

  t(
    'clips.trim-midi',
    'clip.trim(start) on a MIDI clip advances offset and keeps notes in source coordinates',
    async (ctx) => {
      await ctx.commitOk([{ op: 'clip.trim', clipId: 'c-midi', edge: 'start', to: 1 }]);
      const c = ctx.clip(await ctx.project(), 'c-midi');
      ctx.equal(c.start, 1, 'start');
      ctx.close(c.duration, 3, 'duration');
      ctx.close(c.offset, 1, 'offset');
      ctx.equal(c.notes.length, 8, 'notes are kept');
      ctx.equal(c.notes[0].start, 0, 'note n1 start is still in source coordinates');
    },
  ),

  t(
    'clips.split-audio',
    'clip.split cuts an audio clip and advances the right sourceOffset',
    async (ctx) => {
      await ctx.commitOk([
        {
          op: 'clip.update',
          clipId: 'c-audio',
          patch: { fadeIn: { duration: 0.25 }, fadeOut: { duration: 0.25 } },
        },
      ]);
      const rc = await ctx.commitOk([
        { op: 'clip.split', clipId: 'c-audio', at: 6, newClipId: 'c-audio-r' },
      ]);
      ctx.assert(rc.created.includes('c-audio-r'), 'created id missing');
      const p = await ctx.project();
      const left = ctx.clip(p, 'c-audio');
      const right = ctx.clip(p, 'c-audio-r');
      ctx.equal(left.start, 4, 'left start');
      ctx.close(left.duration, 2, 'left duration');
      ctx.close(left.sourceOffset, 1, 'left sourceOffset');
      ctx.equal(right.start, 6, 'right start');
      ctx.close(right.duration, 2, 'right duration');
      // 2 beats at 120 bpm = 1 s of source.
      ctx.close(right.sourceOffset, 2, 'right sourceOffset');
      ctx.equal(right.assetId, left.assetId, 'same asset');
      ctx.assert(left.fadeIn && !left.fadeOut, 'left clip keeps fadeIn, loses fadeOut');
      ctx.assert(!right.fadeIn && right.fadeOut, 'right clip loses fadeIn, keeps fadeOut');
      ctx.equal(ctx.trackOfClip(p, 'c-audio-r').id, 't-audio', 'right clip track');
    },
  ),

  t('clips.split-midi', 'clip.split distributes notes by source position', async (ctx) => {
    await ctx.commitOk([{ op: 'clip.split', clipId: 'c-midi', at: 2, newClipId: 'c-midi-r' }]);
    const p = await ctx.project();
    const left = ctx.clip(p, 'c-midi');
    const right = ctx.clip(p, 'c-midi-r');
    ctx.same(
      left.notes.map((n: Loose) => n.id),
      ['n1', 'n2', 'n3', 'n4'],
      'left notes',
    );
    ctx.same(
      right.notes.map((n: Loose) => n.id),
      ['n5', 'n6', 'n7', 'n8'],
      'right notes',
    );
    ctx.close(left.duration, 2, 'left duration');
    ctx.equal(right.start, 2, 'right start');
    ctx.close(right.duration, 2, 'right duration');
    ctx.close(right.offset, 2, 'right offset');
    ctx.equal(right.notes[0].start, 2, 'right notes stay in source coordinates');
  }),

  t('clips.split-seconds', 'clip.split works in a seconds timebase', async (ctx) => {
    await ctx.commitOk([
      op.insertAudioClip('t-audio', 'c-sec', 0, 4, {
        timebase: 'seconds',
        sourceOffset: 0,
        playbackRate: 2,
      }),
    ]);
    await ctx.commitOk([{ op: 'clip.split', clipId: 'c-sec', at: 1, newClipId: 'c-sec-r' }]);
    const p = await ctx.project();
    const left = ctx.clip(p, 'c-sec');
    const right = ctx.clip(p, 'c-sec-r');
    ctx.close(left.duration, 1, 'left duration');
    ctx.equal(right.start, 1, 'right start');
    ctx.close(right.duration, 3, 'right duration');
    ctx.close(right.sourceOffset, 2, 'right sourceOffset (1 s × rate 2)');
  }),

  t(
    'clips.split-invalid',
    'clip.split needs a position strictly inside the clip and an unused id',
    async (ctx) => {
      await rejects(
        ctx,
        [{ op: 'clip.split', clipId: 'c-audio', at: 4, newClipId: 'x1' }],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [{ op: 'clip.split', clipId: 'c-audio', at: 8, newClipId: 'x2' }],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [{ op: 'clip.split', clipId: 'c-audio', at: 20, newClipId: 'x3' }],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [{ op: 'clip.split', clipId: 'c-audio', at: 6, newClipId: 'c-midi' }],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [{ op: 'clip.split', clipId: 'ghost', at: 1, newClipId: 'x4' }],
        'not_found',
      );
    },
  ),

  t(
    'clips.duplicate',
    'clip.duplicate copies the clip after the source and derives note ids',
    async (ctx) => {
      await ctx.commitOk([{ op: 'clip.duplicate', clipId: 'c-midi', newClipId: 'c-dup' }]);
      let p = await ctx.project();
      const dup = ctx.clip(p, 'c-dup');
      ctx.equal(dup.start, 4, 'default start = end of source');
      ctx.close(dup.duration, 4, 'duration');
      ctx.equal(ctx.trackOfClip(p, 'c-dup').id, 't-midi', 'default track');
      ctx.same(
        dup.notes.map((n: Loose) => n.id).slice(0, 2),
        ['c-dup-n1', 'c-dup-n2'],
        'derived note ids',
      );
      ctx.equal(dup.notes.length, 8, 'note count');
      ctx.equal(ctx.clip(p, 'c-midi').notes.length, 8, 'source unchanged');
      await ctx.commitOk([
        {
          op: 'clip.duplicate',
          clipId: 'c-midi',
          newClipId: 'c-dup2',
          start: 16,
          noteIdPrefix: 'p_',
        },
      ]);
      p = await ctx.project();
      ctx.equal(ctx.clip(p, 'c-dup2').notes[0].id, 'p_n1', 'custom prefix');
      ctx.equal(ctx.clip(p, 'c-dup2').start, 16, 'explicit start');
    },
  ),

  t(
    'clips.duplicate-invalid',
    'clip.duplicate rejects id clashes and incompatible tracks',
    async (ctx) => {
      await rejects(
        ctx,
        [{ op: 'clip.duplicate', clipId: 'c-midi', newClipId: 'c-audio' }],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [{ op: 'clip.duplicate', clipId: 'c-midi', newClipId: 'c-d', trackId: 't-audio' }],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [{ op: 'clip.duplicate', clipId: 'ghost', newClipId: 'c-d' }],
        'not_found',
      );
    },
  ),

  // ------------------------------------------------------------------ MIDI
  t(
    'midi.notes-add',
    'midi.notes.add appends notes; duplicate ids and audio clips are rejected',
    async (ctx) => {
      const rc = await ctx.commitOk([
        {
          op: 'midi.notes.add',
          clipId: 'c-midi',
          notes: [op.note('n9', 74, 3.5, 0.25, 80), op.note('n10', 76, 3.75)],
        },
      ]);
      ctx.assert(rc.created.includes('n9'), 'created id missing');
      const c = ctx.clip(await ctx.project(), 'c-midi');
      ctx.equal(c.notes.length, 10, 'note count');
      const n9 = c.notes.find((n: Loose) => n.id === 'n9');
      ctx.equal(n9.pitch, 74, 'pitch');
      ctx.equal(n9.velocity, 80, 'velocity');
      ctx.equal(n9.channel, 0, 'default channel');
      await rejects(
        ctx,
        [{ op: 'midi.notes.add', clipId: 'c-midi', notes: [op.note('n1')] }],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [{ op: 'midi.notes.add', clipId: 'c-audio', notes: [op.note('z1')] }],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [{ op: 'midi.notes.add', clipId: 'ghost', notes: [op.note('z1')] }],
        'not_found',
      );
    },
  ),

  t(
    'midi.notes-update',
    'midi.notes.update patches notes; unknown notes are not_found',
    async (ctx) => {
      await ctx.commitOk([
        {
          op: 'midi.notes.update',
          clipId: 'c-midi',
          updates: [
            { noteId: 'n1', patch: { pitch: 61, velocity: 42 } },
            { noteId: 'n2', patch: { start: 0.75, duration: 0.25 } },
          ],
        },
      ]);
      const c = ctx.clip(await ctx.project(), 'c-midi');
      const n1 = c.notes.find((n: Loose) => n.id === 'n1');
      const n2 = c.notes.find((n: Loose) => n.id === 'n2');
      ctx.equal(n1.pitch, 61, 'n1 pitch');
      ctx.equal(n1.velocity, 42, 'n1 velocity');
      ctx.equal(n2.start, 0.75, 'n2 start');
      ctx.equal(n2.duration, 0.25, 'n2 duration');
      await rejects(ctx, [op.noteUpdate('ghost', { pitch: 60 })], 'not_found');
      ctx.expectError(await ctx.commit([op.noteUpdate('n1', { pitch: 200 })]), 'invalid_params');
    },
  ),

  t(
    'midi.notes-remove',
    'midi.notes.remove deletes notes; unknown notes are not_found',
    async (ctx) => {
      const rc = await ctx.commitOk([
        { op: 'midi.notes.remove', clipId: 'c-midi', noteIds: ['n1', 'n8'] },
      ]);
      ctx.assert(rc.removed.includes('n1'), 'removed id missing');
      const c = ctx.clip(await ctx.project(), 'c-midi');
      ctx.same(
        c.notes.map((n: Loose) => n.id),
        ['n2', 'n3', 'n4', 'n5', 'n6', 'n7'],
        'remaining notes',
      );
      await rejects(
        ctx,
        [{ op: 'midi.notes.remove', clipId: 'c-midi', noteIds: ['n1'] }],
        'not_found',
      );
    },
  ),

  t(
    'midi.events-update',
    'midi.events.update replaces controller and pitch-bend lists',
    async (ctx) => {
      await ctx.commitOk([
        {
          op: 'midi.events.update',
          clipId: 'c-midi',
          controllers: [
            { time: 1, controller: 1, value: 64 },
            { time: 2, controller: 1, value: 100 },
          ],
          pitchBends: [{ time: 0.5, value: 4096 }],
        },
      ]);
      let c = ctx.clip(await ctx.project(), 'c-midi');
      ctx.equal(c.controllers.length, 2, 'controllers replaced (the CC64 event is gone)');
      ctx.equal(c.controllers[0].controller, 1, 'controller number');
      ctx.equal(c.pitchBends.length, 1, 'pitch bends');
      await ctx.commitOk([{ op: 'midi.events.update', clipId: 'c-midi', controllers: [] }]);
      c = ctx.clip(await ctx.project(), 'c-midi');
      ctx.equal(c.controllers.length, 0, 'controllers cleared');
      ctx.equal(c.pitchBends.length, 1, 'omitted list is left alone');
      await rejects(
        ctx,
        [{ op: 'midi.events.update', clipId: 'c-audio', controllers: [] }],
        'precondition_failed',
      );
    },
  ),

  // ------------------------------------------------------------------ tempo / meter / project / sections
  t(
    'tempo.update',
    'tempo.update replaces the tempo map and changes time conversion',
    async (ctx) => {
      await ctx.commitOk([{ op: 'tempo.update', tempo: [{ beat: 0, bpm: 60 }] }]);
      const p = await ctx.project();
      ctx.same(p.tempo, [{ beat: 0, bpm: 60 }], 'tempo map');
      const d = await ctx.callOk('project.describe');
      ctx.close(d.durationSeconds, 8, 'duration at 60 bpm (8 beats)');
      await ctx.commitOk([
        {
          op: 'tempo.update',
          tempo: [
            { beat: 0, bpm: 120 },
            { beat: 4, bpm: 60 },
          ],
        },
      ]);
      const d2 = await ctx.callOk('project.describe');
      ctx.close(d2.durationSeconds, 2 + 4, 'duration with a tempo change at beat 4');
    },
  ),

  t(
    'tempo.invalid',
    'tempo.update rejects maps that do not start at 0, are unsorted or contain duplicates',
    async (ctx) => {
      await rejects(
        ctx,
        [{ op: 'tempo.update', tempo: [{ beat: 1, bpm: 100 }] }],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [
          {
            op: 'tempo.update',
            tempo: [
              { beat: 0, bpm: 100 },
              { beat: 4, bpm: 90 },
              { beat: 2, bpm: 80 },
            ],
          },
        ],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [
          {
            op: 'tempo.update',
            tempo: [
              { beat: 0, bpm: 100 },
              { beat: 0, bpm: 90 },
            ],
          },
        ],
        'precondition_failed',
      );
      ctx.expectError(
        await ctx.commit([{ op: 'tempo.update', tempo: [{ beat: 0, bpm: 0 }] }]),
        'invalid_params',
      );
      ctx.expectError(await ctx.commit([{ op: 'tempo.update', tempo: [] }]), 'invalid_params');
    },
  ),

  t('meter.update', 'meter.update replaces the meter map', async (ctx) => {
    await ctx.commitOk([
      {
        op: 'meter.update',
        meter: [
          { bar: 0, numerator: 3, denominator: 4 },
          { bar: 4, numerator: 6, denominator: 8 },
        ],
      },
    ]);
    ctx.same(
      (await ctx.project()).meter,
      [
        { bar: 0, numerator: 3, denominator: 4 },
        { bar: 4, numerator: 6, denominator: 8 },
      ],
      'meter map',
    );
    await rejects(
      ctx,
      [{ op: 'meter.update', meter: [{ bar: 2, numerator: 4, denominator: 4 }] }],
      'precondition_failed',
    );
    ctx.expectError(
      await ctx.commit([{ op: 'meter.update', meter: [{ bar: 0, numerator: 4, denominator: 3 }] }]),
      'invalid_params',
    );
  }),

  t('project.update', 'project.update changes name, metadata and sampleRate', async (ctx) => {
    await ctx.commitOk([
      {
        op: 'project.update',
        patch: { name: 'Renamed', metadata: { genre: 'test' }, sampleRate: 44100 },
      },
    ]);
    const p = await ctx.project();
    ctx.equal(p.name, 'Renamed', 'name');
    ctx.equal(p.metadata.genre, 'test', 'metadata');
    ctx.equal(p.sampleRate, 44100, 'sampleRate');
    ctx.expectError(
      await ctx.commit([{ op: 'project.update', patch: { id: 'other' } }]),
      'invalid_params',
    );
    ctx.expectError(
      await ctx.commit([{ op: 'project.update', patch: { sampleRate: 5 } }]),
      'invalid_params',
    );
  }),

  t('sections.crud', 'section.add / update / remove', async (ctx) => {
    await ctx.commitOk([
      {
        op: 'section.add',
        section: { id: 's-2', name: 'Chorus', start: 8, duration: 8, timebase: 'beats' },
      },
    ]);
    let p = await ctx.project();
    ctx.same(
      p.sections.map((s: Loose) => s.id),
      ['s-1', 's-2'],
      'sections after add',
    );
    await ctx.commitOk([
      {
        op: 'section.update',
        sectionId: 's-2',
        patch: { name: 'Hook', duration: 4, color: '#ff0000' },
      },
    ]);
    p = await ctx.project();
    const s2 = p.sections.find((s: Loose) => s.id === 's-2');
    ctx.equal(s2.name, 'Hook', 'name');
    ctx.equal(s2.duration, 4, 'duration');
    ctx.equal(s2.color, '#ff0000', 'color');
    await ctx.commitOk([{ op: 'section.remove', sectionId: 's-1' }]);
    ctx.same(
      (await ctx.project()).sections.map((s: Loose) => s.id),
      ['s-2'],
      'sections after remove',
    );
  }),

  t(
    'sections.invalid',
    'duplicate section ids are rejected; unknown sections are not_found',
    async (ctx) => {
      await rejects(
        ctx,
        [
          {
            op: 'section.add',
            section: { id: 's-1', name: 'Dup', start: 0, duration: 1, timebase: 'beats' },
          },
        ],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [{ op: 'section.update', sectionId: 'ghost', patch: { name: 'x' } }],
        'not_found',
      );
      await rejects(ctx, [{ op: 'section.remove', sectionId: 'ghost' }], 'not_found');
    },
  ),

  // ------------------------------------------------------------------ routing
  t('routing.update', 'routing.update sets the output bus and sends', async (ctx) => {
    await ctx.commitOk([
      {
        op: 'routing.update',
        trackId: 't-midi',
        output: 't-bus',
        sends: [{ targetTrackId: 't-bus', gainDb: -6, preFader: true }],
      },
    ]);
    const tr = ctx.track(await ctx.project(), 't-midi');
    ctx.equal(tr.output, 't-bus', 'output');
    ctx.equal(tr.sends.length, 1, 'sends');
    ctx.equal(tr.sends[0].gainDb, -6, 'send gain');
    ctx.equal(tr.sends[0].preFader, true, 'send preFader');
    await ctx.commitOk([{ op: 'routing.update', trackId: 't-midi', output: 'master', sends: [] }]);
    const back = ctx.track(await ctx.project(), 't-midi');
    ctx.equal(back.output, 'master', 'output after reset');
    ctx.equal(back.sends.length, 0, 'sends after reset');
  }),

  t(
    'routing.invalid-targets',
    'routing to itself, to a missing track or to a non-bus track is rejected',
    async (ctx) => {
      await rejects(
        ctx,
        [{ op: 'routing.update', trackId: 't-bus', output: 't-bus' }],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [{ op: 'routing.update', trackId: 't-midi', output: 'ghost' }],
        'not_found',
      );
      await rejects(
        ctx,
        [{ op: 'routing.update', trackId: 't-midi', output: 't-audio' }],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [
          {
            op: 'routing.update',
            trackId: 't-midi',
            sends: [{ targetTrackId: 'ghost', gainDb: 0, preFader: false }],
          },
        ],
        'not_found',
      );
    },
  ),

  t('routing.cycle', 'a routing cycle is rejected', async (ctx) => {
    await ctx.commitOk([op.addTrack('t-bus2', 'bus', { output: 't-bus' })]);
    await rejects(
      ctx,
      [{ op: 'routing.update', trackId: 't-bus', output: 't-bus2' }],
      'precondition_failed',
    );
    await rejects(
      ctx,
      [
        {
          op: 'routing.update',
          trackId: 't-bus',
          sends: [{ targetTrackId: 't-bus2', gainDb: 0, preFader: false }],
        },
      ],
      'precondition_failed',
    );
  }),

  // ------------------------------------------------------------------ devices
  t('devices.instrument', 'instrument.set replaces and clears the instrument', async (ctx) => {
    await ctx.commitOk([
      {
        op: 'instrument.set',
        trackId: 't-midi',
        instrument: op.device('inst-2', 'aep.sampler', { parameters: { gain: 0.5 } }),
      },
    ]);
    let tr = ctx.track(await ctx.project(), 't-midi');
    ctx.equal(tr.instrument.id, 'inst-2', 'instrument id');
    ctx.equal(tr.instrument.parameters.gain, 0.5, 'instrument parameter');
    await ctx.commitOk([{ op: 'instrument.set', trackId: 't-midi', instrument: null }]);
    tr = ctx.track(await ctx.project(), 't-midi');
    ctx.equal(tr.instrument, null, 'instrument cleared');
    await rejects(ctx, [{ op: 'instrument.set', trackId: 'ghost', instrument: null }], 'not_found');
  }),

  t(
    'devices.effects',
    'effect.insert / update / remove maintain the ordered chain',
    async (ctx) => {
      await ctx.commitOk([
        {
          op: 'effect.insert',
          trackId: 't-midi',
          effect: op.device('fx-a', 'aep.gain', { parameters: { gain: 1 } }),
        },
        { op: 'effect.insert', trackId: 't-midi', effect: op.device('fx-b', 'aep.eq'), index: 0 },
      ]);
      let tr = ctx.track(await ctx.project(), 't-midi');
      ctx.same(
        tr.effects.map((e: Loose) => e.id),
        ['fx-b', 'fx-a'],
        'chain order',
      );
      await ctx.commitOk([
        {
          op: 'effect.update',
          deviceId: 'fx-a',
          patch: { bypass: true, parameters: { gain: 0.25, mix: 0.5 } },
        },
      ]);
      tr = ctx.track(await ctx.project(), 't-midi');
      let fx = tr.effects.find((e: Loose) => e.id === 'fx-a');
      ctx.equal(fx.bypass, true, 'bypass');
      ctx.equal(fx.parameters.gain, 0.25, 'merged gain');
      ctx.equal(fx.parameters.mix, 0.5, 'merged mix');
      await ctx.commitOk([
        { op: 'effect.update', deviceId: 'fx-a', patch: { parameters: { mix: null } } },
      ]);
      fx = ctx.track(await ctx.project(), 't-midi').effects.find((e: Loose) => e.id === 'fx-a');
      ctx.assert(!('mix' in fx.parameters), 'null did not delete the parameter');
      ctx.equal(fx.parameters.gain, 0.25, 'other parameters kept');
      await ctx.commitOk([{ op: 'effect.remove', deviceId: 'fx-b' }]);
      tr = ctx.track(await ctx.project(), 't-midi');
      ctx.same(
        tr.effects.map((e: Loose) => e.id),
        ['fx-a'],
        'chain after remove',
      );
    },
  ),

  t(
    'devices.invalid',
    'device ids are unique across the project; instruments are not effects',
    async (ctx) => {
      await rejects(
        ctx,
        [{ op: 'effect.insert', trackId: 't-audio', effect: op.device('dev-inst') }],
        'precondition_failed',
      );
      await rejects(ctx, [{ op: 'effect.remove', deviceId: 'dev-inst' }], 'precondition_failed');
      await rejects(ctx, [{ op: 'effect.remove', deviceId: 'ghost' }], 'not_found');
      await rejects(
        ctx,
        [{ op: 'effect.update', deviceId: 'ghost', patch: { bypass: true } }],
        'not_found',
      );
      ctx.expectError(
        await ctx.commit([
          { op: 'effect.insert', trackId: 't-audio', effect: op.device('x', 'NotNamespaced') },
        ]),
        'invalid_params',
      );
    },
  ),

  // ------------------------------------------------------------------ automation
  t(
    'automation.lanes',
    'automation lanes can be added, edited by range, and removed',
    async (ctx) => {
      await ctx.commitOk([
        {
          op: 'automation.lane.add',
          trackId: 't-midi',
          lane: {
            id: 'lane-1',
            target: { kind: 'track', parameter: 'gainDb' },
            timebase: 'beats',
            points: [
              { time: 0, value: 0, curve: 'linear' },
              { time: 2, value: -6, curve: 'linear' },
              { time: 4, value: 0, curve: 'step' },
            ],
          },
        },
      ]);
      let lane = ctx
        .track(await ctx.project(), 't-midi')
        .automation.find((l: Loose) => l.id === 'lane-1');
      ctx.equal(lane.points.length, 3, 'initial points');
      await ctx.commitOk([
        {
          op: 'automation.points.update',
          laneId: 'lane-1',
          range: { start: 1, end: 3 },
          points: [{ time: 1.5, value: -3, curve: 'linear' }],
        },
      ]);
      lane = ctx
        .track(await ctx.project(), 't-midi')
        .automation.find((l: Loose) => l.id === 'lane-1');
      ctx.same(
        lane.points.map((p: Loose) => p.time),
        [0, 1.5, 4],
        'points after a ranged replace',
      );
      await ctx.commitOk([
        {
          op: 'automation.points.update',
          laneId: 'lane-1',
          points: [{ time: 0, value: 1, curve: 'step' }],
        },
      ]);
      lane = ctx
        .track(await ctx.project(), 't-midi')
        .automation.find((l: Loose) => l.id === 'lane-1');
      ctx.equal(lane.points.length, 1, 'points after a full replace');
      await ctx.commitOk([{ op: 'automation.lane.remove', laneId: 'lane-1' }]);
      ctx.same(ctx.track(await ctx.project(), 't-midi').automation, [], 'lanes after remove');
    },
  ),

  t(
    'automation.device-target',
    'a device lane must target an existing device on the same track',
    async (ctx) => {
      const lane = (target: Loose, id = 'lane-d'): Loose => ({
        op: 'automation.lane.add',
        trackId: 't-midi',
        lane: { id, target, timebase: 'beats', points: [] },
      });
      await ctx.commitOk([
        { op: 'effect.insert', trackId: 't-midi', effect: op.device('fx-1', 'aep.gain') },
        { op: 'effect.insert', trackId: 't-audio', effect: op.device('fx-other', 'aep.gain') },
      ]);
      await ctx.commitOk([lane({ kind: 'device', deviceId: 'fx-1', parameter: 'gain' })]);
      await rejects(
        ctx,
        [lane({ kind: 'device', deviceId: 'ghost', parameter: 'gain' }, 'lane-e')],
        'not_found',
      );
      await rejects(
        ctx,
        [lane({ kind: 'device', deviceId: 'fx-other', parameter: 'gain' }, 'lane-f')],
        'precondition_failed',
      );
    },
  ),

  t(
    'automation.invalid',
    'duplicate lane ids and duplicate point times in points.update are rejected',
    async (ctx) => {
      const add = (id: string, points: Loose[] = []): Loose => ({
        op: 'automation.lane.add',
        trackId: 't-midi',
        lane: { id, target: { kind: 'track', parameter: 'pan' }, timebase: 'beats', points },
      });
      await ctx.commitOk([add('lane-1', [{ time: 0, value: 0, curve: 'linear' }])]);
      await rejects(ctx, [add('lane-1')], 'precondition_failed');
      await rejects(
        ctx,
        [
          {
            op: 'automation.points.update',
            laneId: 'lane-1',
            points: [
              { time: 2, value: 0, curve: 'linear' },
              { time: 2, value: 1, curve: 'linear' },
            ],
          },
        ],
        'precondition_failed',
      );
      await rejects(
        ctx,
        [{ op: 'automation.points.update', laneId: 'ghost', points: [] }],
        'not_found',
      );
      await rejects(ctx, [{ op: 'automation.lane.remove', laneId: 'ghost' }], 'not_found');
    },
  ),

  // ------------------------------------------------------------------ assets
  t('assets.unlink', 'asset.unlink removes an unreferenced asset from the project', async (ctx) => {
    await rejects(ctx, [{ op: 'asset.unlink', assetId: 'a-1' }], 'precondition_failed');
    await ctx.commitOk([
      { op: 'clip.remove', clipId: 'c-audio' },
      { op: 'asset.unlink', assetId: 'a-1' },
    ]);
    const p = await ctx.project();
    ctx.same(p.assets, [], 'project assets');
    await rejects(ctx, [{ op: 'asset.unlink', assetId: 'a-1' }], 'not_found');
  }),

  t(
    'assets.link-unknown',
    'asset.link of an asset the host does not hold is asset_not_found',
    async (ctx) => {
      await rejects(ctx, [{ op: 'asset.link', assetId: 'never-imported' }], 'asset_not_found');
      // Already part of the project: nothing to link.
      await rejects(
        ctx,
        [{ op: 'asset.link', assetId: 'a-1' }],
        ['precondition_failed', 'asset_not_found'],
      );
    },
  ),

  t('assets.device-reference', 'an asset used by a device cannot be unlinked', async (ctx) => {
    await ctx.commitOk([
      {
        op: 'instrument.set',
        trackId: 't-midi',
        instrument: op.device('inst-sf', 'aep.soundfont', { assetId: 'a-1' }),
      },
    ]);
    await rejects(
      ctx,
      [
        { op: 'clip.remove', clipId: 'c-audio' },
        { op: 'asset.unlink', assetId: 'a-1' },
      ],
      'precondition_failed',
    );
  }),
];
