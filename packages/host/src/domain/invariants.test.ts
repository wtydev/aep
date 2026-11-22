import { describe, expect, it } from 'vitest';
import type { AudioClip, Diagnostic, Limits, Project } from '@wty.dev/aep-schema';
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
        { beat: 4, bpm: 120, curve: 'step' },
        { beat: 0, bpm: 90, curve: 'step' },
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

  it('catches device-target lanes whose device is not on the same track', () => {
    const p = mutate((p) => {
      // 'dev-inst' lives on t-midi, not t-audio; 'nope' exists nowhere.
      const audio = p.tracks.find((t) => t.id === 't-audio')!;
      audio.automation.push(
        {
          id: 'al-1',
          target: { kind: 'device', deviceId: 'dev-inst', parameter: 'gain' },
          timebase: 'beats',
          points: [],
        },
        {
          id: 'al-2',
          target: { kind: 'device', deviceId: 'nope', parameter: 'gain' },
          timebase: 'beats',
          points: [],
        },
      );
      // A lane on the same track as its device is fine.
      p.tracks
        .find((t) => t.id === 't-midi')!
        .automation.push({
          id: 'al-3',
          target: { kind: 'device', deviceId: 'dev-inst', parameter: 'gain' },
          timebase: 'beats',
          points: [],
        });
    });
    const m = messages(check(p));
    expect(m).toContain(
      "automation lane 'al-1' targets device 'dev-inst' which is not on track 't-audio'",
    );
    expect(m).toContain(
      "automation lane 'al-2' targets device 'nope' which is not on track 't-audio'",
    );
    expect(m).not.toContain('al-3');
  });

  it('catches unsorted and duplicated automation lane points', () => {
    const p = mutate((p) => {
      p.tracks
        .find((t) => t.id === 't-audio')!
        .automation.push(
          {
            id: 'al-1',
            target: { kind: 'track', parameter: 'gainDb' },
            timebase: 'beats',
            points: [
              { time: 2, value: 0, curve: 'linear' },
              { time: 1, value: 0, curve: 'linear' },
            ],
          },
          {
            id: 'al-2',
            target: { kind: 'track', parameter: 'pan' },
            timebase: 'beats',
            points: [
              { time: 0, value: 0, curve: 'linear' },
              { time: 0, value: 1, curve: 'linear' },
            ],
          },
        );
    });
    const m = messages(check(p));
    expect(m).toContain("automation lane 'al-1' points are not sorted by time");
    expect(m).toContain("automation lane 'al-2' has a duplicate point time 0");
  });

  it('catches duplicate send targets within a track', () => {
    const p = mutate((p) => {
      p.tracks.find((t) => t.id === 't-midi')!.sends = [
        { targetTrackId: 't-bus', gainDb: 0, preFader: false },
        { targetTrackId: 't-bus', gainDb: -3, preFader: false },
      ];
    });
    expect(messages(check(p))).toContain("track 't-midi' has duplicate send target 't-bus'");
  });

  it('catches non-audio asset media types on audio clips', () => {
    const midiAsset = mutate((p) => {
      p.assets[0]!.mediaType = 'audio/midi';
    });
    expect(messages(check(midiAsset))).toContain(
      "clip 'c-audio' references asset 'a-1' with mediaType 'audio/midi'",
    );
    const nonAudio = mutate((p) => {
      p.assets[0]!.mediaType = 'application/zip';
    });
    expect(messages(check(nonAudio))).toContain("mediaType 'application/zip'");
  });

  it('catches audio clips reading beyond the asset durationSeconds', () => {
    const audioClip = (p: Project): AudioClip => {
      const c = p.tracks.find((t) => t.id === 't-audio')!.clips[0]!;
      if (c.type !== 'audio') throw new Error('not an audio clip');
      return c;
    };
    // Demo clip: 4 beats @120bpm = 2s, sourceOffset 1, rate 1, asset 4s → boundary ok.
    const atBoundary = mutate((p) => {
      audioClip(p).sourceOffset = 2;
    });
    expect(check(atBoundary)).toEqual([]);
    const overByOffset = mutate((p) => {
      audioClip(p).sourceOffset = 2.5;
    });
    expect(messages(check(overByOffset))).toContain('durationSeconds 4');
    const overByRate = mutate((p) => {
      audioClip(p).playbackRate = 3;
    });
    expect(messages(check(overByRate))).toContain('reads source up to 7s');
    // Loop bounds use loop.length instead of the clip's timeline length.
    const loopOver = mutate((p) => {
      audioClip(p).loop = { enabled: true, length: 3.5 };
    });
    expect(messages(check(loopOver))).toContain('reads source up to 4.5s');
    const loopInside = mutate((p) => {
      audioClip(p).loop = { enabled: true, length: 3 };
    });
    expect(check(loopInside)).toEqual([]);
    // A disabled loop falls back to the timeline-length rule.
    const loopDisabled = mutate((p) => {
      audioClip(p).loop = { enabled: false, length: 1 };
      audioClip(p).sourceOffset = 2.5;
    });
    expect(messages(check(loopDisabled))).toContain('reads source up to 4.5s');
    // Assets without durationSeconds are not checked.
    const noDuration = mutate((p) => {
      delete p.assets[0]!.durationSeconds;
      audioClip(p).sourceOffset = 500;
    });
    expect(check(noDuration)).toEqual([]);
    // A beats-timebase clip is measured through the tempo map: at 60bpm, 9 beats
    // of clip is 9 seconds of source.
    const slowerTempo = mutate((p) => {
      p.tempo = [{ beat: 0, bpm: 60, curve: 'step' }];
      audioClip(p).sourceOffset = 0;
      audioClip(p).duration = 9;
    });
    expect(messages(check(slowerTempo))).toContain('reads source up to 9s');
  });
});
