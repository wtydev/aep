import { describe, expect, it } from 'vitest';
import { demoProject } from './fixtures.js';
import { flattenProject, unflattenProject } from './flatten.js';

describe('flattenProject', () => {
  it('emits every entity path of the design §3 table', () => {
    const map = flattenProject(demoProject());
    expect([...map.keys()].sort()).toEqual(
      [
        '/project',
        '/tempo',
        '/meter',
        '/trackOrder',
        '/tracks/t-midi',
        '/tracks/t-midi/instrument',
        '/tracks/t-midi/effectOrder',
        '/tracks/t-midi/clips/c-midi',
        '/tracks/t-midi/clips/c-midi/midiEvents',
        ...[...Array(8).keys()].map((i) => `/tracks/t-midi/clips/c-midi/notes/n${i + 1}`),
        '/tracks/t-audio',
        '/tracks/t-audio/effectOrder',
        '/tracks/t-audio/clips/c-audio',
        '/tracks/t-bus',
        '/tracks/t-bus/effectOrder',
        '/sections/s-1',
        '/assets/a-1',
      ].sort(),
    );
  });

  it('values exclude child collections', () => {
    const map = flattenProject(demoProject());
    const track = map.get('/tracks/t-midi')!.value as Record<string, unknown>;
    expect(track).not.toHaveProperty('clips');
    expect(track).not.toHaveProperty('effects');
    expect(track).not.toHaveProperty('automation');
    expect(track).not.toHaveProperty('instrument');
    expect(track.id).toBe('t-midi');

    const clip = map.get('/tracks/t-midi/clips/c-midi')!.value as Record<string, unknown>;
    expect(clip).not.toHaveProperty('notes');
    expect(clip).not.toHaveProperty('controllers');
    expect(clip).not.toHaveProperty('pitchBends');
    expect(clip.type).toBe('midi');

    const events = map.get('/tracks/t-midi/clips/c-midi/midiEvents')!.value as {
      controllers: unknown[];
      pitchBends: unknown[];
    };
    expect(events.controllers).toHaveLength(1);
  });

  it('omits instrument and midiEvents entities where they do not apply', () => {
    const map = flattenProject(demoProject());
    expect(map.has('/tracks/t-audio/instrument')).toBe(false);
    expect(map.has('/tracks/t-audio/clips/c-audio/midiEvents')).toBe(false);
    expect(map.has('/tracks/t-audio/clips/c-audio/notes/n1')).toBe(false);
  });
});

describe('unflattenProject', () => {
  it('is the exact inverse of flattenProject', () => {
    const project = demoProject();
    expect(unflattenProject(flattenProject(project))).toEqual(project);
  });

  it('round-trips tempo point curves', () => {
    const project = demoProject();
    project.tempo = [
      { beat: 0, bpm: 60, curve: 'linear' },
      { beat: 4, bpm: 120, curve: 'step' },
    ];
    const restored = unflattenProject(flattenProject(project));
    expect(restored).toEqual(project);
    expect(restored.tempo[0]!.curve).toBe('linear');
  });
});
