import { describe, expect, it } from 'vitest';
import { Operation } from '@aep/schema';
import type { AudioClip, ErrorCode, MidiClip, Operation as OperationT, Project } from '@aep/schema';
import type { AepError } from '@aep/core';
import { isAepError } from '@aep/core';
import { applyOperation, applyOperations } from './apply.js';
import { DEMO_LIMITS, demoContext, demoProject } from './fixtures.js';

const ctx = demoContext();
const op = (input: unknown): OperationT => Operation.parse(input);
const apply = (p: Project, input: unknown, c = ctx): Project => applyOperation(p, op(input), c);

const midiClip = (p: Project, id = 'c-midi'): MidiClip => {
  for (const t of p.tracks) {
    const c = t.clips.find((x) => x.id === id);
    if (c) return c as MidiClip;
  }
  throw new Error(`clip ${id} not found`);
};
const audioClip = (p: Project, id = 'c-audio'): AudioClip =>
  p.tracks.flatMap((t) => t.clips).find((c) => c.id === id) as AudioClip;
const track = (p: Project, id: string) => p.tracks.find((t) => t.id === id)!;

const expectCode = (fn: () => unknown, code: ErrorCode): AepError => {
  try {
    fn();
  } catch (e) {
    expect(isAepError(e)).toBe(true);
    expect((e as AepError).code).toBe(code);
    return e as AepError;
  }
  throw new Error(`expected AepError ${code}`);
};

describe('applyOperation basics', () => {
  it('is pure: never mutates the input', () => {
    const p = demoProject();
    const snapshot = structuredClone(p);
    apply(p, { op: 'clip.remove', clipId: 'c-midi' });
    expect(p).toEqual(snapshot);
  });

  it('rejects operations whose capability is not advertised', () => {
    const noCaps = demoContext({ capabilities: new Set<string>() });
    expectCode(
      () => apply(demoProject(), { op: 'clip.remove', clipId: 'c-midi' }, noCaps),
      'capability_unsupported',
    );
  });
});

describe('project.update', () => {
  it('patches top-level fields', () => {
    const r = apply(demoProject(), {
      op: 'project.update',
      patch: { name: 'Renamed', metadata: { key: 'value' } },
    });
    expect(r.name).toBe('Renamed');
    expect(r.metadata).toEqual({ key: 'value' });
  });
});

describe('track.add', () => {
  it('inserts at the requested index, including nested entities', () => {
    const r = apply(demoProject(), {
      op: 'track.add',
      index: 0,
      track: {
        id: 't-new',
        name: 'New',
        kind: 'midi',
        clips: [{ id: 'c-n', type: 'midi', start: 0, duration: 2, timebase: 'beats' }],
      },
    });
    expect(r.tracks.map((t) => t.id)).toEqual(['t-new', 't-midi', 't-audio', 't-bus']);
    expect(r.tracks[0]!.clips[0]!.id).toBe('c-n');
  });

  it('defaults to appending and clamps the index', () => {
    const r = apply(demoProject(), {
      op: 'track.add',
      index: 99,
      track: { id: 't-new', name: 'N', kind: 'midi' },
    });
    expect(r.tracks[3]!.id).toBe('t-new');
  });

  it('rejects duplicate ids anywhere in the payload or project', () => {
    const base = {
      op: 'track.add' as const,
      track: { id: 't-midi', name: 'D', kind: 'midi' as const },
    };
    expectCode(() => apply(demoProject(), base), 'precondition_failed');
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'track.add',
          track: {
            id: 't-new',
            name: 'N',
            kind: 'midi',
            clips: [{ id: 'c-midi', type: 'midi', start: 0, duration: 1, timebase: 'beats' }],
          },
        }),
      'precondition_failed',
    );
  });

  it('rejects nested clips incompatible with the track kind and missing assets', () => {
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'track.add',
          track: {
            id: 't-new',
            name: 'N',
            kind: 'midi',
            clips: [
              {
                id: 'c-n',
                type: 'audio',
                start: 0,
                duration: 1,
                timebase: 'beats',
                assetId: 'a-1',
              },
            ],
          },
        }),
      'precondition_failed',
    );
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'track.add',
          track: {
            id: 't-new',
            name: 'N',
            kind: 'audio',
            clips: [
              {
                id: 'c-n',
                type: 'audio',
                start: 0,
                duration: 1,
                timebase: 'beats',
                assetId: 'a-x',
              },
            ],
          },
        }),
      'not_found',
    );
  });

  it('enforces maxTracks', () => {
    const c = demoContext({ limits: { ...DEMO_LIMITS, maxTracks: 3 } });
    expectCode(
      () =>
        apply(
          demoProject(),
          { op: 'track.add', track: { id: 't-new', name: 'N', kind: 'midi' } },
          c,
        ),
      'limit_exceeded',
    );
  });
});

describe('track.update', () => {
  it('applies the patch', () => {
    const r = apply(demoProject(), {
      op: 'track.update',
      trackId: 't-midi',
      patch: { gainDb: -6, parentId: 't-bus' },
    });
    expect(track(r, 't-midi').gainDb).toBe(-6);
    expect(track(r, 't-midi').parentId).toBe('t-bus');
  });

  it('rejects missing tracks, self-parents and missing parents', () => {
    expectCode(
      () => apply(demoProject(), { op: 'track.update', trackId: 't-x', patch: {} }),
      'not_found',
    );
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'track.update',
          trackId: 't-midi',
          patch: { parentId: 't-midi' },
        }),
      'precondition_failed',
    );
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'track.update',
          trackId: 't-midi',
          patch: { parentId: 'nope' },
        }),
      'not_found',
    );
  });
});

describe('track.remove', () => {
  it('removes the track and its descendants', () => {
    const r = apply(demoProject(), { op: 'track.remove', trackId: 't-midi' });
    expect(r.tracks.map((t) => t.id)).toEqual(['t-audio', 't-bus']);
  });

  it('fails while other tracks reference it', () => {
    expectCode(
      () => apply(demoProject(), { op: 'track.remove', trackId: 't-bus' }),
      'precondition_failed',
    );
    expectCode(() => apply(demoProject(), { op: 'track.remove', trackId: 't-x' }), 'not_found');
  });
});

describe('track.reorder', () => {
  it('moves to the requested index, clamped', () => {
    const r = apply(demoProject(), { op: 'track.reorder', trackId: 't-bus', index: 0 });
    expect(r.tracks.map((t) => t.id)).toEqual(['t-bus', 't-midi', 't-audio']);
    const r2 = apply(demoProject(), { op: 'track.reorder', trackId: 't-midi', index: 99 });
    expect(r2.tracks[2]!.id).toBe('t-midi');
    expectCode(
      () => apply(demoProject(), { op: 'track.reorder', trackId: 't-x', index: 0 }),
      'not_found',
    );
  });
});

describe('clip.insert', () => {
  it('inserts a compatible clip', () => {
    const r = apply(demoProject(), {
      op: 'clip.insert',
      trackId: 't-audio',
      clip: { id: 'c-2', type: 'audio', start: 0, duration: 2, timebase: 'beats', assetId: 'a-1' },
    });
    expect(track(r, 't-audio').clips).toHaveLength(2);
  });

  it('enforces track-type compatibility and unique ids', () => {
    const audioClipInput = {
      id: 'c-2',
      type: 'audio',
      start: 0,
      duration: 1,
      timebase: 'beats',
      assetId: 'a-1',
    };
    expectCode(
      () => apply(demoProject(), { op: 'clip.insert', trackId: 't-midi', clip: audioClipInput }),
      'precondition_failed',
    );
    const midiClipInput = { id: 'c-midi', type: 'midi', start: 0, duration: 1, timebase: 'beats' };
    expectCode(
      () => apply(demoProject(), { op: 'clip.insert', trackId: 't-midi', clip: midiClipInput }),
      'precondition_failed',
    );
    expectCode(
      () => apply(demoProject(), { op: 'clip.insert', trackId: 'nope', clip: audioClipInput }),
      'not_found',
    );
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'clip.insert',
          trackId: 't-audio',
          clip: { ...audioClipInput, assetId: 'a-missing' },
        }),
      'not_found',
    );
  });
});

describe('clip.update', () => {
  it('patches fields and clears nullable fields with null', () => {
    let r = apply(demoProject(), {
      op: 'clip.update',
      clipId: 'c-audio',
      patch: { name: 'Take 2', fadeOut: { duration: 1 } },
    });
    expect(audioClip(r).name).toBe('Take 2');
    expect(audioClip(r).fadeOut?.duration).toBe(1);
    r = apply(r, { op: 'clip.update', clipId: 'c-audio', patch: { fadeOut: null } });
    expect(audioClip(r).fadeOut).toBeUndefined();
  });

  it('rejects type-specific fields on the wrong clip type', () => {
    expectCode(
      () =>
        apply(demoProject(), { op: 'clip.update', clipId: 'c-midi', patch: { sourceOffset: 1 } }),
      'precondition_failed',
    );
    expectCode(
      () => apply(demoProject(), { op: 'clip.update', clipId: 'c-audio', patch: { offset: 1 } }),
      'precondition_failed',
    );
    expectCode(
      () => apply(demoProject(), { op: 'clip.update', clipId: 'nope', patch: {} }),
      'not_found',
    );
  });
});

describe('clip.remove', () => {
  it('removes the clip', () => {
    const r = apply(demoProject(), { op: 'clip.remove', clipId: 'c-audio' });
    expect(track(r, 't-audio').clips).toHaveLength(0);
    expectCode(() => apply(demoProject(), { op: 'clip.remove', clipId: 'nope' }), 'not_found');
  });
});

describe('clip.move', () => {
  it('moves within the same track and across compatible tracks', () => {
    let r = apply(demoProject(), { op: 'clip.move', clipId: 'c-audio', start: 8 });
    expect(audioClip(r).start).toBe(8);

    r = apply(r, { op: 'track.add', track: { id: 't-hyb', name: 'H', kind: 'hybrid' } });
    r = apply(r, { op: 'clip.move', clipId: 'c-midi', trackId: 't-hyb', start: 2 });
    expect(track(r, 't-hyb').clips[0]!.id).toBe('c-midi');
    expect(track(r, 't-midi').clips).toHaveLength(0);
  });

  it('rejects incompatible tracks and missing entities', () => {
    expectCode(
      () => apply(demoProject(), { op: 'clip.move', clipId: 'c-midi', trackId: 't-audio' }),
      'precondition_failed',
    );
    expectCode(
      () => apply(demoProject(), { op: 'clip.move', clipId: 'c-midi', trackId: 'nope' }),
      'not_found',
    );
    expectCode(() => apply(demoProject(), { op: 'clip.move', clipId: 'nope' }), 'not_found');
  });
});

describe('clip.trim', () => {
  it('audio start trim advances sourceOffset through the tempo map', () => {
    // 120 bpm → 0.5 s/beat. Trimming start 4 → 5 advances sourceOffset by 0.5 s.
    const r = apply(demoProject(), { op: 'clip.trim', clipId: 'c-audio', edge: 'start', to: 5 });
    const c = audioClip(r);
    expect(c.start).toBe(5);
    expect(c.duration).toBe(3);
    expect(c.sourceOffset).toBeCloseTo(1.5);
  });

  it('audio start can extend left while sourceOffset stays ≥ 0', () => {
    const r = apply(demoProject(), { op: 'clip.trim', clipId: 'c-audio', edge: 'start', to: 3 });
    const c = audioClip(r);
    expect(c.start).toBe(3);
    expect(c.duration).toBe(5);
    expect(c.sourceOffset).toBeCloseTo(0.5);
  });

  it('rejects trims that violate duration or source bounds', () => {
    expectCode(
      () => apply(demoProject(), { op: 'clip.trim', clipId: 'c-audio', edge: 'start', to: 8 }),
      'precondition_failed',
    );
    expectCode(
      () => apply(demoProject(), { op: 'clip.trim', clipId: 'c-audio', edge: 'start', to: 0 }),
      'precondition_failed',
    );
    expectCode(
      () => apply(demoProject(), { op: 'clip.trim', clipId: 'c-audio', edge: 'end', to: 4 }),
      'precondition_failed',
    );
    expectCode(
      () => apply(demoProject(), { op: 'clip.trim', clipId: 'nope', edge: 'end', to: 4 }),
      'not_found',
    );
  });

  it('end trim sets duration from start', () => {
    const r = apply(demoProject(), { op: 'clip.trim', clipId: 'c-audio', edge: 'end', to: 6 });
    expect(audioClip(r).duration).toBe(2);
  });

  it('midi start trim advances offset in clip units', () => {
    const r = apply(demoProject(), { op: 'clip.trim', clipId: 'c-midi', edge: 'start', to: 1 });
    const c = midiClip(r);
    expect(c.start).toBe(1);
    expect(c.duration).toBe(3);
    expect(c.offset).toBe(1);
    // Notes keep their source coordinates.
    expect(c.notes.map((n) => n.id)).toHaveLength(8);
    expect(c.notes[0]!.start).toBe(0);
  });
});

describe('clip.split', () => {
  const split = (p: Project, at = 2): Project =>
    apply(p, { op: 'clip.split', clipId: 'c-midi', at, newClipId: 'c-right' });

  it('partitions notes by source position and advances the right offset', () => {
    const r = split(demoProject());
    const left = midiClip(r, 'c-midi');
    const right = midiClip(r, 'c-right');
    expect(left.start).toBe(0);
    expect(left.duration).toBe(2);
    expect(left.offset).toBe(0);
    expect(right.start).toBe(2);
    expect(right.duration).toBe(2);
    expect(right.offset).toBe(2);
    // S = 0 + (2 - 0) = 2: notes n1..n4 (starts < 2) left, n5..n8 right.
    expect(left.notes.map((n) => n.id)).toEqual(['n1', 'n2', 'n3', 'n4']);
    expect(right.notes.map((n) => n.id)).toEqual(['n5', 'n6', 'n7', 'n8']);
    // Controllers are copied to both.
    expect(left.controllers).toEqual(right.controllers);
    // The right clip sits directly after the left on the same track.
    const ids = track(r, 't-midi').clips.map((c) => c.id);
    expect(ids).toEqual(['c-midi', 'c-right']);
  });

  it('keeps fadeIn on the left and fadeOut on the right', () => {
    const withFades = apply(demoProject(), {
      op: 'clip.update',
      clipId: 'c-midi',
      patch: { fadeIn: { duration: 0.5 }, fadeOut: { duration: 0.25 } },
    });
    const r = split(withFades);
    const left = midiClip(r, 'c-midi');
    const right = midiClip(r, 'c-right');
    expect(left.fadeIn?.duration).toBe(0.5);
    expect(left.fadeOut).toBeUndefined();
    expect(right.fadeIn).toBeUndefined();
    expect(right.fadeOut?.duration).toBe(0.25);
  });

  it('advances audio sourceOffset for the right clip', () => {
    const r = apply(demoProject(), {
      op: 'clip.split',
      clipId: 'c-audio',
      at: 6,
      newClipId: 'c-right',
    });
    const right = audioClip(r, 'c-right');
    // 2 beats at 120 bpm = 1 s of source.
    expect(right.sourceOffset).toBeCloseTo(2);
    expect(right.start).toBe(6);
    expect(right.duration).toBe(2);
  });

  it('rejects out-of-range split points and duplicate ids', () => {
    expectCode(() => split(demoProject(), 4), 'precondition_failed');
    expectCode(() => split(demoProject(), 10), 'precondition_failed');
    expectCode(
      () =>
        apply(demoProject(), { op: 'clip.split', clipId: 'c-midi', at: 2, newClipId: 'c-audio' }),
      'precondition_failed',
    );
    expectCode(
      () => apply(demoProject(), { op: 'clip.split', clipId: 'nope', at: 1, newClipId: 'x' }),
      'not_found',
    );
  });
});

describe('clip.duplicate', () => {
  it('copies the clip after the source with prefixed note ids', () => {
    const r = apply(demoProject(), { op: 'clip.duplicate', clipId: 'c-midi', newClipId: 'c-copy' });
    const copy = midiClip(r, 'c-copy');
    expect(copy.start).toBe(4);
    expect(copy.duration).toBe(4);
    expect(copy.notes.map((n) => n.id)).toEqual([
      'c-copy-n1',
      'c-copy-n2',
      'c-copy-n3',
      'c-copy-n4',
      'c-copy-n5',
      'c-copy-n6',
      'c-copy-n7',
      'c-copy-n8',
    ]);
    expect(copy.controllers).toEqual(midiClip(r).controllers);
  });

  it('honours explicit start, track and note prefix', () => {
    let r = apply(demoProject(), {
      op: 'track.add',
      track: { id: 't-hyb', name: 'H', kind: 'hybrid' },
    });
    r = apply(r, {
      op: 'clip.duplicate',
      clipId: 'c-midi',
      newClipId: 'c-copy',
      start: 8,
      trackId: 't-hyb',
      noteIdPrefix: 'x:',
    });
    const copy = track(r, 't-hyb').clips[0]! as MidiClip;
    expect(copy.id).toBe('c-copy');
    expect(copy.start).toBe(8);
    expect(copy.notes[0]!.id).toBe('x:n1');
  });

  it('rejects duplicate clip ids and incompatible targets', () => {
    expectCode(
      () => apply(demoProject(), { op: 'clip.duplicate', clipId: 'c-midi', newClipId: 'c-audio' }),
      'precondition_failed',
    );
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'clip.duplicate',
          clipId: 'c-midi',
          newClipId: 'c-copy',
          trackId: 't-audio',
        }),
      'precondition_failed',
    );
  });
});

describe('midi.notes.*', () => {
  it('adds notes', () => {
    const r = apply(demoProject(), {
      op: 'midi.notes.add',
      clipId: 'c-midi',
      notes: [{ id: 'n9', pitch: 84, start: 4, duration: 1, velocity: 90 }],
    });
    expect(midiClip(r).notes).toHaveLength(9);
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'midi.notes.add',
          clipId: 'c-midi',
          notes: [{ id: 'n1', pitch: 1, start: 0, duration: 1, velocity: 1 }],
        }),
      'precondition_failed',
    );
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'midi.notes.add',
          clipId: 'c-audio',
          notes: [{ id: 'x1', pitch: 1, start: 0, duration: 1, velocity: 1 }],
        }),
      'precondition_failed',
    );
    const tight = demoContext({ limits: { ...DEMO_LIMITS, maxNotesPerClip: 8 } });
    expectCode(
      () =>
        apply(
          demoProject(),
          {
            op: 'midi.notes.add',
            clipId: 'c-midi',
            notes: [{ id: 'n9', pitch: 1, start: 0, duration: 1, velocity: 1 }],
          },
          tight,
        ),
      'limit_exceeded',
    );
  });

  it('patches existing notes', () => {
    const r = apply(demoProject(), {
      op: 'midi.notes.update',
      clipId: 'c-midi',
      updates: [
        { noteId: 'n1', patch: { velocity: 50 } },
        { noteId: 'n2', patch: { pitch: 100, start: 1 } },
      ],
    });
    const notes = midiClip(r).notes;
    expect(notes.find((n) => n.id === 'n1')!.velocity).toBe(50);
    expect(notes.find((n) => n.id === 'n2')!.pitch).toBe(100);
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'midi.notes.update',
          clipId: 'c-midi',
          updates: [{ noteId: 'nope', patch: { velocity: 1 } }],
        }),
      'not_found',
    );
  });

  it('removes notes', () => {
    const r = apply(demoProject(), {
      op: 'midi.notes.remove',
      clipId: 'c-midi',
      noteIds: ['n1', 'n2'],
    });
    expect(midiClip(r).notes.map((n) => n.id)).toEqual(['n3', 'n4', 'n5', 'n6', 'n7', 'n8']);
    expectCode(
      () => apply(demoProject(), { op: 'midi.notes.remove', clipId: 'c-midi', noteIds: ['nope'] }),
      'not_found',
    );
  });
});

describe('midi.events.update', () => {
  it('replaces the provided lists only', () => {
    const r = apply(demoProject(), {
      op: 'midi.events.update',
      clipId: 'c-midi',
      pitchBends: [{ time: 0.5, value: 4096 }],
    });
    const c = midiClip(r);
    expect(c.pitchBends).toEqual([{ time: 0.5, value: 4096, channel: 0 }]);
    expect(c.controllers).toHaveLength(1);
    expectCode(
      () => apply(demoProject(), { op: 'midi.events.update', clipId: 'c-audio', controllers: [] }),
      'precondition_failed',
    );
  });
});

describe('tempo.update / meter.update', () => {
  it('replaces the maps', () => {
    const r = apply(demoProject(), {
      op: 'tempo.update',
      tempo: [
        { beat: 0, bpm: 90 },
        { beat: 8, bpm: 140 },
      ],
    });
    expect(r.tempo).toHaveLength(2);
    const r2 = apply(demoProject(), {
      op: 'meter.update',
      meter: [{ bar: 0, numerator: 3, denominator: 4 }],
    });
    expect(r2.meter[0]!.numerator).toBe(3);
  });

  it('requires sorted maps starting at 0 without duplicates', () => {
    expectCode(
      () => apply(demoProject(), { op: 'tempo.update', tempo: [{ beat: 1, bpm: 90 }] }),
      'precondition_failed',
    );
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'tempo.update',
          tempo: [
            { beat: 4, bpm: 90 },
            { beat: 0, bpm: 120 },
          ],
        }),
      'precondition_failed',
    );
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'tempo.update',
          tempo: [
            { beat: 0, bpm: 90 },
            { beat: 0, bpm: 120 },
          ],
        }),
      'precondition_failed',
    );
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'meter.update',
          meter: [{ bar: 2, numerator: 3, denominator: 4 }],
        }),
      'precondition_failed',
    );
  });
});

describe('section ops', () => {
  it('adds, updates and removes sections', () => {
    let r = apply(demoProject(), {
      op: 'section.add',
      section: { id: 's-2', name: 'Chorus', start: 8, duration: 8 },
    });
    expect(r.sections).toHaveLength(2);
    r = apply(r, { op: 'section.update', sectionId: 's-2', patch: { start: 9, name: 'C' } });
    expect(r.sections.find((s) => s.id === 's-2')!.start).toBe(9);
    r = apply(r, { op: 'section.remove', sectionId: 's-2' });
    expect(r.sections).toHaveLength(1);
  });

  it('rejects duplicates and missing sections', () => {
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'section.add',
          section: { id: 's-1', name: 'Dup', start: 0, duration: 1 },
        }),
      'precondition_failed',
    );
    expectCode(
      () => apply(demoProject(), { op: 'section.remove', sectionId: 'nope' }),
      'not_found',
    );
  });
});

describe('routing.update', () => {
  it('sets output and sends to bus tracks', () => {
    const r = apply(demoProject(), {
      op: 'routing.update',
      trackId: 't-midi',
      output: 't-bus',
      sends: [{ targetTrackId: 't-bus', gainDb: -6, preFader: true }],
    });
    expect(track(r, 't-midi').output).toBe('t-bus');
    expect(track(r, 't-midi').sends[0]!.gainDb).toBe(-6);
  });

  it('rejects non-bus, missing and self targets', () => {
    expectCode(
      () => apply(demoProject(), { op: 'routing.update', trackId: 't-midi', output: 't-audio' }),
      'precondition_failed',
    );
    expectCode(
      () => apply(demoProject(), { op: 'routing.update', trackId: 't-midi', output: 'nope' }),
      'not_found',
    );
    expectCode(
      () => apply(demoProject(), { op: 'routing.update', trackId: 't-midi', output: 't-midi' }),
      'precondition_failed',
    );
  });

  it('rejects routing cycles', () => {
    let r = apply(demoProject(), {
      op: 'track.add',
      track: { id: 't-b2', name: 'B2', kind: 'bus' },
    });
    r = apply(r, { op: 'routing.update', trackId: 't-bus', output: 't-b2' });
    expectCode(
      () => apply(r, { op: 'routing.update', trackId: 't-b2', output: 't-bus' }),
      'precondition_failed',
    );
  });
});

describe('instrument.set', () => {
  it('sets and clears instruments', () => {
    let r = apply(demoProject(), {
      op: 'instrument.set',
      trackId: 't-audio',
      instrument: { id: 'dev-2', type: 'aep.synth' },
    });
    expect(track(r, 't-audio').instrument?.id).toBe('dev-2');
    r = apply(r, { op: 'instrument.set', trackId: 't-midi', instrument: null });
    expect(track(r, 't-midi').instrument).toBeNull();
  });

  it('rejects duplicate device ids and missing assets', () => {
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'instrument.set',
          trackId: 't-audio',
          instrument: { id: 'dev-inst', type: 'aep.synth' },
        }),
      'precondition_failed',
    );
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'instrument.set',
          trackId: 't-audio',
          instrument: { id: 'dev-2', type: 'aep.soundfont', assetId: 'a-nope' },
        }),
      'not_found',
    );
  });
});

describe('effect ops', () => {
  it('inserts effects at an index', () => {
    const r = apply(demoProject(), {
      op: 'effect.insert',
      trackId: 't-audio',
      effect: { id: 'fx-1', type: 'aep.eq' },
      index: 0,
    });
    expect(track(r, 't-audio').effects[0]!.id).toBe('fx-1');
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'effect.insert',
          trackId: 't-audio',
          effect: { id: 'dev-inst', type: 'aep.eq' },
        }),
      'precondition_failed',
    );
  });

  it('merges parameters with null deletes; works on instruments too', () => {
    const r = apply(demoProject(), {
      op: 'effect.update',
      deviceId: 'dev-inst',
      patch: { bypass: true, parameters: { gain: 0.5, preset: null, extra: 2 } },
    });
    const inst = track(r, 't-midi').instrument!;
    expect(inst.bypass).toBe(true);
    expect(inst.parameters).toEqual({ gain: 0.5, extra: 2 });
    expectCode(
      () => apply(demoProject(), { op: 'effect.update', deviceId: 'nope', patch: {} }),
      'not_found',
    );
  });

  it('removes effects but refuses instruments', () => {
    let r = apply(demoProject(), {
      op: 'effect.insert',
      trackId: 't-audio',
      effect: { id: 'fx-1', type: 'aep.eq' },
    });
    r = apply(r, { op: 'effect.remove', deviceId: 'fx-1' });
    expect(track(r, 't-audio').effects).toHaveLength(0);
    expectCode(
      () => apply(demoProject(), { op: 'effect.remove', deviceId: 'dev-inst' }),
      'precondition_failed',
    );
    expectCode(() => apply(demoProject(), { op: 'effect.remove', deviceId: 'nope' }), 'not_found');
  });
});

describe('automation ops', () => {
  const lane = {
    id: 'al-1',
    target: { kind: 'track' as const, parameter: 'gainDb' as const },
    points: [
      { time: 0, value: -3 },
      { time: 2, value: 0 },
    ],
  };

  it('adds lanes and validates device targets live on the same track', () => {
    const r = apply(demoProject(), { op: 'automation.lane.add', trackId: 't-audio', lane });
    expect(track(r, 't-audio').automation).toHaveLength(1);
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'automation.lane.add',
          trackId: 't-audio',
          lane: { ...lane, target: { kind: 'device', deviceId: 'dev-inst', parameter: 'gain' } },
        }),
      'precondition_failed',
    );
    expectCode(
      () =>
        apply(demoProject(), {
          op: 'automation.lane.add',
          trackId: 't-audio',
          lane: { ...lane, target: { kind: 'device', deviceId: 'nope', parameter: 'gain' } },
        }),
      'not_found',
    );
    expectCode(
      () => apply(r, { op: 'automation.lane.add', trackId: 't-audio', lane }),
      'precondition_failed',
    );
  });

  it('replaces points inside a range and keeps them sorted', () => {
    let r = apply(demoProject(), { op: 'automation.lane.add', trackId: 't-audio', lane });
    r = apply(r, {
      op: 'automation.points.update',
      laneId: 'al-1',
      range: { start: 0, end: 1.5 },
      points: [{ time: 0.5, value: 5 }],
    });
    expect(track(r, 't-audio').automation[0]!.points).toEqual([
      { time: 0.5, value: 5, curve: 'linear' },
      { time: 2, value: 0, curve: 'linear' },
    ]);
    // Without a range, all points are replaced.
    r = apply(r, {
      op: 'automation.points.update',
      laneId: 'al-1',
      points: [
        { time: 3, value: 1 },
        { time: 1, value: 2 },
      ],
    });
    expect(track(r, 't-audio').automation[0]!.points.map((p) => p.time)).toEqual([1, 3]);
  });

  it('rejects duplicate point times', () => {
    const r = apply(demoProject(), { op: 'automation.lane.add', trackId: 't-audio', lane });
    expectCode(
      () =>
        apply(r, {
          op: 'automation.points.update',
          laneId: 'al-1',
          points: [
            { time: 1, value: 0 },
            { time: 1, value: 2 },
          ],
        }),
      'precondition_failed',
    );
    // Collision with a kept point.
    expectCode(
      () =>
        apply(r, {
          op: 'automation.points.update',
          laneId: 'al-1',
          range: { start: 0, end: 1 },
          points: [{ time: 2, value: 9 }],
        }),
      'precondition_failed',
    );
    expectCode(
      () => apply(r, { op: 'automation.points.update', laneId: 'nope', points: [] }),
      'not_found',
    );
  });

  it('removes lanes', () => {
    let r = apply(demoProject(), { op: 'automation.lane.add', trackId: 't-audio', lane });
    r = apply(r, { op: 'automation.lane.remove', laneId: 'al-1' });
    expect(track(r, 't-audio').automation).toHaveLength(0);
    expectCode(
      () => apply(demoProject(), { op: 'automation.lane.remove', laneId: 'nope' }),
      'not_found',
    );
  });
});

describe('asset.link / asset.unlink', () => {
  it('copies a store asset into the project', () => {
    const r = apply(demoProject(), { op: 'asset.link', assetId: 'a-store-1' });
    expect(r.assets.map((a) => a.id)).toContain('a-store-1');
    expectCode(
      () => apply(demoProject(), { op: 'asset.link', assetId: 'a-nope' }),
      'asset_not_found',
    );
    expectCode(
      () => apply(demoProject(), { op: 'asset.link', assetId: 'a-1' }),
      'precondition_failed',
    );
  });

  it('unlinks unreferenced project assets only', () => {
    expectCode(
      () => apply(demoProject(), { op: 'asset.unlink', assetId: 'a-1' }),
      'precondition_failed',
    );
    expectCode(() => apply(demoProject(), { op: 'asset.unlink', assetId: 'a-nope' }), 'not_found');
    let r = apply(demoProject(), { op: 'asset.link', assetId: 'a-store-1' });
    r = apply(r, { op: 'asset.unlink', assetId: 'a-store-1' });
    expect(r.assets.map((a) => a.id)).not.toContain('a-store-1');
  });
});

describe('applyOperations', () => {
  it('applies operations in order', () => {
    const r = applyOperations(
      demoProject(),
      [
        op({ op: 'project.update', patch: { name: 'Multi' } }),
        op({ op: 'section.add', section: { id: 's-2', name: 'B', start: 8, duration: 4 } }),
        op({ op: 'track.reorder', trackId: 't-bus', index: 0 }),
      ],
      ctx,
    );
    expect(r.name).toBe('Multi');
    expect(r.sections).toHaveLength(2);
    expect(r.tracks[0]!.id).toBe('t-bus');
  });

  it('wraps failures with operationIndex and entity path', () => {
    try {
      applyOperations(
        demoProject(),
        [
          op({ op: 'project.update', patch: { name: 'x' } }),
          op({ op: 'routing.update', trackId: 't-midi', output: 'nope' }),
        ],
        ctx,
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(isAepError(e)).toBe(true);
      const err = e as AepError;
      expect(err.code).toBe('not_found');
      expect(err.message).toContain('operation 1 (routing.update)');
      expect(err.diagnostics[0]).toMatchObject({
        code: 'not_found',
        operationIndex: 1,
        path: '/tracks/t-midi',
      });
    }
  });
});
