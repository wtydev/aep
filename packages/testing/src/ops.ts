/** Small builders for operations and entities, used by the conformance tests (plain JSON). */
import type { Loose } from './context.js';

export const op = {
  renameTrack: (trackId: string, name: string): Loose => ({
    op: 'track.update',
    trackId,
    patch: { name },
  }),
  renameClip: (clipId: string, name: string): Loose => ({
    op: 'clip.update',
    clipId,
    patch: { name },
  }),
  noteUpdate: (noteId: string, patch: Record<string, unknown>, clipId = 'c-midi'): Loose => ({
    op: 'midi.notes.update',
    clipId,
    updates: [{ noteId, patch }],
  }),
  addTrack: (
    id: string,
    kind: string,
    extra: Record<string, unknown> = {},
    index?: number,
  ): Loose => ({
    op: 'track.add',
    track: { id, name: id, kind, ...extra },
    ...(index !== undefined ? { index } : {}),
  }),
  insertMidiClip: (
    trackId: string,
    id: string,
    start = 0,
    duration = 4,
    extra: Record<string, unknown> = {},
  ): Loose => ({
    op: 'clip.insert',
    trackId,
    clip: { id, type: 'midi', start, duration, timebase: 'beats', ...extra },
  }),
  insertAudioClip: (
    trackId: string,
    id: string,
    start = 0,
    duration = 4,
    extra: Record<string, unknown> = {},
  ): Loose => ({
    op: 'clip.insert',
    trackId,
    clip: { id, type: 'audio', assetId: 'a-1', start, duration, timebase: 'beats', ...extra },
  }),
  note: (id: string, pitch = 60, start = 0, duration = 0.5, velocity = 100): Loose => ({
    id,
    pitch,
    start,
    duration,
    velocity,
  }),
  device: (id: string, type = 'aep.gain', extra: Record<string, unknown> = {}): Loose => ({
    id,
    type,
    ...extra,
  }),
};
