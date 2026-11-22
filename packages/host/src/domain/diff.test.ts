import { describe, expect, it } from 'vitest';
import { Operation } from '@aep/schema';
import { applyOperation } from './apply.js';
import { createdRemoved, projectDiff } from './diff.js';
import { demoContext, demoProject } from './fixtures.js';

const ctx = demoContext();

describe('projectDiff', () => {
  it('is empty for identical states', () => {
    const p = demoProject();
    expect(projectDiff(p, structuredClone(p))).toEqual([]);
  });

  it('reports a field update at the entity path', () => {
    const before = demoProject();
    const after = applyOperation(
      before,
      Operation.parse({ op: 'track.update', trackId: 't-midi', patch: { gainDb: -6, mute: true } }),
      ctx,
    );
    const changes = projectDiff(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      path: '/tracks/t-midi',
      entity: 'track',
      kind: 'update',
      fields: ['gainDb', 'mute'],
    });
  });

  it('reports a clip move across tracks as remove + add', () => {
    const before = applyOperation(
      demoProject(),
      Operation.parse({ op: 'track.add', track: { id: 't-hyb', name: 'H', kind: 'hybrid' } }),
      ctx,
    );
    const after = applyOperation(
      before,
      Operation.parse({ op: 'clip.move', clipId: 'c-midi', trackId: 't-hyb' }),
      ctx,
    );
    const changes = projectDiff(before, after);
    const paths = changes.map((c) => `${c.kind}:${c.path}`);
    expect(paths).toContain('remove:/tracks/t-midi/clips/c-midi/notes/n8');
    expect(paths).toContain('remove:/tracks/t-midi/clips/c-midi');
    expect(paths).toContain('add:/tracks/t-hyb/clips/c-midi');
    expect(paths).toContain('add:/tracks/t-hyb/clips/c-midi/midiEvents');

    const { created, removed } = createdRemoved(changes);
    expect(created).toContain('c-midi');
    expect(created).toContain('n8');
    expect(removed).toContain('c-midi');
    expect(removed).toContain('n8');
    // midiEvents is not an id-bearing entity.
    expect(created).not.toContain('midiEvents');
  });

  it('reports the device id (not the path segment) for instrument changes', () => {
    const before = demoProject();
    const track = before.tracks.find((t) => t.instrument)!;
    const after = applyOperation(
      before,
      { op: 'instrument.set', trackId: track.id, instrument: null },
      ctx,
    );
    const { removed } = createdRemoved(projectDiff(before, after));
    expect(removed).toEqual([track.instrument!.id]);
  });
});
