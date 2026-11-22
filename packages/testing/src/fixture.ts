/**
 * The project every conformance test starts from, and the files seeded into the `inbox` import
 * root. Hosts under test receive both through the launcher contract.
 */
import { Project } from '@aep/schema';

/** Ids of the entities in {@link CONFORMANCE_FIXTURE}. */
export const IDS = {
  project: 'aep-conformance',
  tMidi: 't-midi',
  tAudio: 't-audio',
  tBus: 't-bus',
  cMidi: 'c-midi',
  cAudio: 'c-audio',
  section: 's-1',
  asset: 'a-1',
  instrument: 'dev-inst',
} as const;

/**
 * 120 bpm, 4/4. `t-midi` (instrument) holds MIDI clip `c-midi` (beats 0..4, notes n1..n8 at
 * pitches 60,62,64,65,67,69,71,72, starting every half beat, 0.5 beat long). `t-audio` (audio,
 * output `t-bus`) holds audio clip `c-audio` (beats 4..8, asset `a-1`, sourceOffset 1 s).
 */
export const CONFORMANCE_FIXTURE: Project = Project.parse({
  id: IDS.project,
  name: 'Conformance Project',
  sampleRate: 48_000,
  tempo: [{ beat: 0, bpm: 120 }],
  meter: [{ bar: 0, numerator: 4, denominator: 4 }],
  tracks: [
    {
      id: IDS.tMidi,
      name: 'Keys',
      kind: 'instrument',
      instrument: {
        id: IDS.instrument,
        type: 'aep.soundfont',
        name: 'Piano',
        parameters: { gain: 0.8, preset: 'grand' },
      },
      clips: [
        {
          id: IDS.cMidi,
          type: 'midi',
          name: 'Riff',
          start: 0,
          duration: 4,
          timebase: 'beats',
          offset: 0,
          notes: [60, 62, 64, 65, 67, 69, 71, 72].map((pitch, i) => ({
            id: `n${i + 1}`,
            pitch,
            start: i * 0.5,
            duration: 0.5,
            velocity: 100,
          })),
          controllers: [{ time: 0, controller: 64, value: 127 }],
          pitchBends: [],
        },
      ],
    },
    {
      id: IDS.tAudio,
      name: 'Audio',
      kind: 'audio',
      output: IDS.tBus,
      clips: [
        {
          id: IDS.cAudio,
          type: 'audio',
          name: 'Take',
          start: 4,
          duration: 4,
          timebase: 'beats',
          assetId: IDS.asset,
          sourceOffset: 1,
          playbackRate: 1,
        },
      ],
    },
    { id: IDS.tBus, name: 'Bus', kind: 'bus' },
  ],
  sections: [{ id: IDS.section, name: 'Verse', start: 0, duration: 8, timebase: 'beats' }],
  assets: [
    {
      id: IDS.asset,
      name: 'take.wav',
      mediaType: 'audio/wav',
      contentHash: `sha256:${'0'.repeat(64)}`,
      byteLength: 384_000,
      durationSeconds: 4,
      sampleRate: 48_000,
      channels: 2,
      availability: 'available',
      portability: 'host-local',
    },
  ],
});

/** A valid 16-bit PCM mono WAV holding a quiet sine tone. */
export function makeWav(sampleRate = 48_000, seconds = 0.25): Uint8Array {
  const samples = Math.round(sampleRate * seconds);
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 3000), 44 + i * 2);
  }
  return new Uint8Array(buf);
}

/** Facts about the standard inbox, for the asset tests. */
export const INBOX = {
  wav: 'tone.wav',
  wavSampleRate: 48_000,
  wavChannels: 1,
  wavSeconds: 0.25,
  notMedia: 'notes.json',
} as const;

/**
 * Files every launcher seeds into the `inbox` import root (relative path → bytes). The host
 * under test must be started with an import root named `inbox` that contains exactly these.
 */
export function standardInbox(): Record<string, Uint8Array> {
  return {
    [INBOX.wav]: makeWav(INBOX.wavSampleRate, INBOX.wavSeconds),
    [INBOX.notMedia]: new TextEncoder().encode('{"not":"media"}\n'),
  };
}
