import { describe, expect, it } from 'vitest';
import type { Diagnostic, Limits, Project } from '@aep/schema';
import { validateInvariants } from './invariants.js';
import { DEMO_LIMITS, demoProject } from './fixtures.js';

const check = (p: Project, limits: Limits = DEMO_LIMITS): Diagnostic[] =>
  validateInvariants(p, limits);

const mutate = (fn: (p: Project) => void): Project => {
  const p = demoProject();
  fn(p);
  return p;
};

const messages = (diags: Diagnostic[]): string => diags.map((d) => d.message).join('\n');

describe('validateInvariants', () => {
  it('accepts the demo project', () => {
    expect(check(demoProject())).toEqual([]);
  });

  it('catches duplicate ids per id space', () => {
    const p = mutate((p) => {
      p.tracks.push(structuredClone(p.tracks[0]!));
      p.sections.push({ ...p.sections[0]! });
      const audio = p.tracks.find((t) => t.id === 't-audio')!;
      audio.clips.push({ ...structuredClone(audio.clips[0]!), id: 'c-midi' });
    });
    const m = messages(check(p));
    expect(m).toContain("duplicate track id 't-midi'");
    expect(m).toContain("duplicate section id 's-1'");
    expect(m).toContain("duplicate clip id 'c-midi'");
  });

  it('catches unsorted and non-zero-based tempo and meter maps', () => {
    const p = mutate((p) => {
      p.tempo = [
        { beat: 4, bpm: 120 },
        { beat: 0, bpm: 90 },
      ];
      p.meter = [{ bar: 1, numerator: 4, denominator: 4 }];
    });
    const m = messages(check(p));
    expect(m).toContain('tempo map must start at beat 0');
    expect(m).toContain('tempo map must be sorted by beat');
    expect(m).toContain('meter map must start at bar 0');
  });

  it('catches audio clips referencing missing project assets', () => {
    const p = mutate((p) => {
      p.assets = [];
    });
    expect(messages(check(p))).toContain("clip 'c-audio' references asset 'a-1'");
  });

  it('catches clips on incompatible tracks', () => {
    const p = mutate((p) => {
      const midi = p.tracks.find((t) => t.id === 't-midi')!;
      const audio = p.tracks.find((t) => t.id === 't-audio')!;
      const bus = p.tracks.find((t) => t.id === 't-bus')!;
      bus.clips.push(...midi.clips);
      midi.clips = [];
      audio.kind = 'midi';
    });
    const m = messages(check(p));
    expect(m).toContain("'midi' clip 'c-midi' lives on incompatible 'bus' track");
    expect(m).toContain("'audio' clip 'c-audio' lives on incompatible 'midi' track");
  });

  it('catches routing cycles and invalid targets', () => {
    const cyclic = mutate((p) => {
      const bus = p.tracks.find((t) => t.id === 't-bus')!;
      p.tracks.push({ ...structuredClone(bus), id: 't-b2', output: 't-bus' });
      bus.output = 't-b2';
    });
    expect(messages(check(cyclic))).toContain('routing graph contains a cycle');

    const badTarget = mutate((p) => {
      p.tracks.find((t) => t.id === 't-midi')!.output = 't-audio';
      p.tracks
        .find((t) => t.id === 't-bus')!
        .sends.push({ targetTrackId: 'nope', gainDb: 0, preFader: false });
    });
    const m = messages(check(badTarget));
    expect(m).toContain("outputs to 'audio' track 't-audio'");
    expect(m).toContain("sends to unknown track 'nope'");
  });

  it('catches missing and cyclic parentId chains', () => {
    const missing = mutate((p) => {
      p.tracks.find((t) => t.id === 't-midi')!.parentId = 'nope';
    });
    expect(messages(check(missing))).toContain("track 't-midi' has unknown parent 'nope'");

    const cyclic = mutate((p) => {
      p.tracks.find((t) => t.id === 't-midi')!.parentId = 't-audio';
      p.tracks.find((t) => t.id === 't-audio')!.parentId = 't-midi';
    });
    expect(messages(check(cyclic))).toContain('parentId cycle');
  });

  it('enforces limits', () => {
    const p = demoProject();
    expect(messages(check(p, { ...DEMO_LIMITS, maxTracks: 2 }))).toContain('above maxTracks');
    expect(messages(check(p, { ...DEMO_LIMITS, maxNotesPerClip: 4 }))).toContain(
      "clip 'c-midi' has 8 notes, above maxNotesPerClip",
    );
  });

  it('catches device assetIds missing from project.assets', () => {
    const p = mutate((p) => {
      p.tracks.find((t) => t.id === 't-midi')!.instrument!.assetId = 'a-nope';
    });
    expect(messages(check(p))).toContain("device 'dev-inst' references asset 'a-nope'");
  });

  it('catches duplicate note ids inside a clip', () => {
    const p = mutate((p) => {
      const clip = p.tracks.find((t) => t.id === 't-midi')!.clips[0]!;
      if (clip.type === 'midi') clip.notes.push({ ...clip.notes[0]! });
    });
    expect(messages(check(p))).toContain("duplicate note id 'n1'");
  });
});
