import { describe, expect, it } from 'vitest';
import { Operation } from '@wty.dev/aep-schema';
import type { Diagnostic, Operation as OperationT, Project, Scope } from '@wty.dev/aep-schema';
import { applyOperation, applyOperations } from './apply.js';
import { projectDiff } from './diff.js';
import { checkScope } from './scope.js';
import { demoContext, demoProject } from './fixtures.js';

const ctx = demoContext();
const op = (input: unknown): OperationT => Operation.parse(input);

const scoped = (before: Project, ops: OperationT[], scope: Scope): Diagnostic[] => {
  const after = applyOperations(before, ops, ctx);
  return checkScope({
    changes: projectDiff(before, after),
    operations: ops,
    scope,
    before,
    after,
  });
};

const noteUpdate = op({
  op: 'midi.notes.update',
  clipId: 'c-midi',
  updates: [{ noteId: 'n1', patch: { velocity: 50 } }],
});

describe('checkScope — tracks and clips', () => {
  it('allows edits inside the permitted clip and rejects the rest', () => {
    const p = demoProject();
    expect(scoped(p, [noteUpdate], { clips: ['c-midi'] })).toEqual([]);
    const diags = scoped(p, [noteUpdate], { clips: ['c-audio'] });
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      code: 'scope_violation',
      path: '/tracks/t-midi/clips/c-midi/notes/n1',
    });
  });

  it('allows edits inside permitted tracks only', () => {
    const p = demoProject();
    expect(scoped(p, [noteUpdate], { tracks: ['t-midi'] })).toEqual([]);
    expect(scoped(p, [noteUpdate], { tracks: ['t-audio', 't-bus'] })).toHaveLength(1);
  });

  it('rejects project-level changes under a track scope', () => {
    const p = demoProject();
    const diags = scoped(p, [op({ op: 'tempo.update', tempo: [{ beat: 0, bpm: 90 }] })], {
      tracks: ['t-midi'],
    });
    expect(diags).toHaveLength(1);
    expect(diags[0]!.path).toBe('/tempo');
  });

  it('allows a clip to move across tracks under its clip scope, unless tracks forbids it', () => {
    const before = applyOperation(
      demoProject(),
      op({ op: 'track.add', track: { id: 't-hyb', name: 'H', kind: 'hybrid' } }),
      ctx,
    );
    const move = op({ op: 'clip.move', clipId: 'c-midi', trackId: 't-hyb' });
    expect(scoped(before, [move], { clips: ['c-midi'] })).toEqual([]);
    // tracks scope permits the remove but not the add under the destination track.
    expect(scoped(before, [move], { tracks: ['t-midi'] }).length).toBeGreaterThan(0);
    expect(scoped(before, [move], { tracks: ['t-midi', 't-hyb'] })).toEqual([]);
  });
});

describe('checkScope — operations', () => {
  it('matches operation patterns', () => {
    const p = demoProject();
    expect(scoped(p, [noteUpdate], { operations: ['midi.notes.*'] })).toEqual([]);
    expect(scoped(p, [noteUpdate], { operations: ['*'] })).toEqual([]);
    const diags = scoped(p, [noteUpdate], { operations: ['clip.*'] });
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ code: 'scope_violation', operationIndex: 0 });
  });
});

describe('checkScope — properties', () => {
  it('checks update fields and add/remove collection names', () => {
    const p = demoProject();
    expect(scoped(p, [noteUpdate], { properties: ['velocity'] })).toEqual([]);
    expect(scoped(p, [noteUpdate], { properties: ['pitch', 'start'] })).toHaveLength(1);

    const remove = op({ op: 'midi.notes.remove', clipId: 'c-midi', noteIds: ['n1'] });
    expect(scoped(p, [remove], { properties: ['notes'] })).toEqual([]);
    expect(scoped(p, [remove], { properties: ['clips'] })).toHaveLength(1);

    const tempo = op({ op: 'tempo.update', tempo: [{ beat: 0, bpm: 90 }] });
    expect(scoped(p, [tempo], { properties: ['tempo'] })).toEqual([]);
    expect(scoped(p, [tempo], { properties: ['meter'] })).toHaveLength(1);
  });
});

describe('checkScope — timeRange', () => {
  const range = { start: 0, end: 2, unit: 'seconds' as const };

  it('allows a note edit whose timeline extent stays inside the range', () => {
    // n8: start 3.5→3.0 beats. 120bpm → 0.5s/beat: extent moves [1.75,2] → [1.5,1.75].
    const move = op({
      op: 'midi.notes.update',
      clipId: 'c-midi',
      updates: [{ noteId: 'n8', patch: { start: 3 } }],
    });
    expect(scoped(demoProject(), [move], { timeRange: range })).toEqual([]);
  });

  it('rejects a note moved outside the range', () => {
    // n8 to beat 6 → extent [3,3.25]s, outside [0,2].
    const move = op({
      op: 'midi.notes.update',
      clipId: 'c-midi',
      updates: [{ noteId: 'n8', patch: { start: 6 } }],
    });
    const diags = scoped(demoProject(), [move], { timeRange: range });
    expect(diags).toHaveLength(1);
    expect(diags[0]!.path).toBe('/tracks/t-midi/clips/c-midi/notes/n8');
  });

  it('rejects non-time-bearing changes: tempo, track gain, devices', () => {
    const p = demoProject();
    const wide = { start: 0, end: 100, unit: 'seconds' as const };
    expect(
      scoped(p, [op({ op: 'tempo.update', tempo: [{ beat: 0, bpm: 90 }] })], {
        timeRange: wide,
      }),
    ).toHaveLength(1);
    expect(
      scoped(p, [op({ op: 'track.update', trackId: 't-midi', patch: { gainDb: -3 } })], {
        timeRange: wide,
      }),
    ).toHaveLength(1);
    expect(
      scoped(p, [op({ op: 'effect.update', deviceId: 'dev-inst', patch: { bypass: true } })], {
        timeRange: wide,
      }),
    ).toHaveLength(1);
  });

  it('rejects a clip moved outside the range', () => {
    const move = op({ op: 'clip.move', clipId: 'c-midi', start: 6 });
    // After extent [3,5]s outside [0,2].
    expect(scoped(demoProject(), [move], { timeRange: range })).toHaveLength(1);
  });

  it('accepts beat-unit ranges via the tempo map', () => {
    // c-midi spans beats 0..4 = 0..2s; range beats 0..8 is generous.
    const move = op({ op: 'clip.move', clipId: 'c-midi', start: 4 });
    expect(
      scoped(demoProject(), [move], { timeRange: { start: 0, end: 8, unit: 'beats' } }),
    ).toEqual([]);
  });

  it('converts extents through a ramped tempo map', () => {
    // 60→120 bpm linear over beats 0..4 (slope 15): seconds(b) = 4·ln(1 + b/4).
    // n8 moves 3.5→3.0 beats: extent [4ln1.875≈2.514, 4ln2≈2.773] → [4ln1.75≈2.238, 2.514].
    const p = demoProject();
    p.tempo = [
      { beat: 0, bpm: 60, curve: 'linear' },
      { beat: 4, bpm: 120, curve: 'step' },
    ];
    const move = op({
      op: 'midi.notes.update',
      clipId: 'c-midi',
      updates: [{ noteId: 'n8', patch: { start: 3 } }],
    });
    expect(scoped(p, [move], { timeRange: { start: 0, end: 2.8, unit: 'seconds' } })).toEqual([]);
    const diags = scoped(p, [move], { timeRange: { start: 2.51, end: 2.78, unit: 'seconds' } });
    expect(diags).toHaveLength(1);
    expect(diags[0]!.path).toBe('/tracks/t-midi/clips/c-midi/notes/n8');
    // Beat-unit ranges use the same conversion.
    expect(scoped(p, [move], { timeRange: { start: 0, end: 4, unit: 'beats' } })).toEqual([]);
  });
});
