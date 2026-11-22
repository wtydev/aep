/**
 * Shared test fixture: a demo project (120 bpm, 4/4) with an instrument track holding a MIDI
 * clip of 8 notes, an audio track holding an audio clip that references a linked asset, a bus
 * track, and one section — plus matching limits, capabilities and a store-asset lookup.
 */
import { OPERATION_CAPABILITY, Project } from '@aep/schema';
import type { Asset, Limits, Project as ProjectT } from '@aep/schema';
import type { ApplyContext } from './apply.js';

export const DEMO_LIMITS: Limits = {
  maxOperationsPerTransaction: 100,
  maxRequestBytes: 1_048_576,
  maxNotesPerClip: 10_000,
  maxTracks: 256,
  maxOpenProposals: 32,
  receiptRetention: 1000,
};

export const DEMO_CAPABILITIES: ReadonlySet<string> = new Set([
  'aep.core',
  'aep.proposals',
  'aep.history',
  'aep.render',
  'aep.generation',
  'aep.jobs',
  'aep.audio.assets.import',
  ...Object.values(OPERATION_CAPABILITY),
]);

export const STORE_ASSETS: Record<string, Asset> = {
  'a-store-1': {
    id: 'a-store-1',
    name: 'imported-take.wav',
    mediaType: 'audio/wav',
    contentHash: `sha256:${'1'.repeat(64)}`,
    byteLength: 192_000,
    durationSeconds: 2,
    sampleRate: 48_000,
    channels: 2,
    availability: 'available',
    portability: 'host-local',
  },
};

export const demoContext = (overrides?: Partial<ApplyContext>): ApplyContext => ({
  capabilities: DEMO_CAPABILITIES,
  limits: DEMO_LIMITS,
  lookupStoreAsset: (id) => STORE_ASSETS[id],
  ...overrides,
});

/** Freshly parsed demo project on every call. */
export function demoProject(): ProjectT {
  return Project.parse({
    id: 'demo',
    name: 'Demo Project',
    sampleRate: 48_000,
    tempo: [{ beat: 0, bpm: 120 }],
    meter: [{ bar: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        id: 't-midi',
        name: 'Keys',
        kind: 'instrument',
        instrument: {
          id: 'dev-inst',
          type: 'aep.soundfont',
          name: 'Piano',
          parameters: { gain: 0.8, preset: 'grand' },
        },
        clips: [
          {
            id: 'c-midi',
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
        id: 't-audio',
        name: 'Audio',
        kind: 'audio',
        output: 't-bus',
        clips: [
          {
            id: 'c-audio',
            type: 'audio',
            name: 'Take',
            start: 4,
            duration: 4,
            timebase: 'beats',
            assetId: 'a-1',
            sourceOffset: 1,
            playbackRate: 1,
          },
        ],
      },
      {
        id: 't-bus',
        name: 'Bus',
        kind: 'bus',
      },
    ],
    sections: [{ id: 's-1', name: 'Verse', start: 0, duration: 8, timebase: 'beats' }],
    assets: [
      {
        id: 'a-1',
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
}
