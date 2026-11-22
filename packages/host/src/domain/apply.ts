import {
  AutomationLane,
  AutomationPoint,
  Clip,
  ClipPatch,
  ControllerEvent,
  Device,
  DevicePatch,
  MeterPoint,
  Note,
  OPERATION_CAPABILITY,
  PitchBendEvent,
  Project,
  ProjectPatch,
  Section,
  SectionPatch,
  TempoPoint,
  Track,
  TrackPatch,
  toSeconds,
} from '@aep/schema';
import type {
  Asset,
  Diagnostic,
  ErrorCode,
  Id,
  Limits,
  MidiClip,
  Operation,
  TrackKind,
} from '@aep/schema';
import { AepError, isAepError } from '@aep/core';

/** Inputs an operation needs beyond the project value itself. */
export interface ApplyContext {
  /** Capabilities the host advertised; each op's `OPERATION_CAPABILITY` must be present. */
  capabilities: ReadonlySet<string>;
  limits: Limits;
  /** Host asset store lookup for `asset.link`. */
  lookupStoreAsset(id: string): Asset | undefined;
}

function fail(code: ErrorCode, message: string, path?: string): never {
  throw new AepError(code, message, path ? [{ code, message, path }] : []);
}

function notFound(what: string, path?: string): never {
  return fail('not_found', `${what} not found`, path);
}

function badPrecondition(message: string, path?: string): never {
  return fail('precondition_failed', message, path);
}

interface Parseable<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly { message: string }[] } };
}

function parseOrFail<T>(schema: Parseable<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new AepError(
      'invalid_params',
      `invalid ${what}: ${r.error.issues[0]?.message ?? 'does not match schema'}`,
    );
  }
  return r.data;
}

// ---------------------------------------------------------------- lookups

interface LocatedClip {
  track: Track;
  clip: Clip;
  index: number;
}

function findClip(project: Project, clipId: Id): LocatedClip | undefined {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index]!, index };
  }
  return undefined;
}

interface LocatedDevice {
  track: Track;
  device: Device;
  where: 'instrument' | 'effect';
  index: number;
}

function findDevice(project: Project, deviceId: Id): LocatedDevice | undefined {
  for (const track of project.tracks) {
    if (track.instrument?.id === deviceId) {
      return { track, device: track.instrument, where: 'instrument', index: -1 };
    }
    const index = track.effects.findIndex((d) => d.id === deviceId);
    if (index >= 0) return { track, device: track.effects[index]!, where: 'effect', index };
  }
  return undefined;
}

interface LocatedLane {
  track: Track;
  lane: AutomationLane;
  index: number;
}

function findLane(project: Project, laneId: Id): LocatedLane | undefined {
  for (const track of project.tracks) {
    const index = track.automation.findIndex((l) => l.id === laneId);
    if (index >= 0) return { track, lane: track.automation[index]!, index };
  }
  return undefined;
}

interface IdSpaces {
  tracks: Set<Id>;
  clips: Set<Id>;
  devices: Set<Id>;
  lanes: Set<Id>;
  sections: Set<Id>;
  assets: Set<Id>;
}

function collectIds(project: Project): IdSpaces {
  const ids: IdSpaces = {
    tracks: new Set(),
    clips: new Set(),
    devices: new Set(),
    lanes: new Set(),
    sections: new Set(),
    assets: new Set(),
  };
  for (const t of project.tracks) {
    ids.tracks.add(t.id);
    if (t.instrument) ids.devices.add(t.instrument.id);
    for (const d of t.effects) ids.devices.add(d.id);
    for (const c of t.clips) ids.clips.add(c.id);
    for (const l of t.automation) ids.lanes.add(l.id);
  }
  for (const s of project.sections) ids.sections.add(s.id);
  for (const a of project.assets) ids.assets.add(a.id);
  return ids;
}

/** Which track kinds accept which clip types (design §4). */
export function trackAcceptsClip(kind: TrackKind, clipType: 'audio' | 'midi'): boolean {
  return clipType === 'audio'
    ? kind === 'audio' || kind === 'hybrid'
    : kind === 'midi' || kind === 'instrument' || kind === 'hybrid';
}

const checkCompatible = (kind: TrackKind, clip: Clip): void => {
  if (!trackAcceptsClip(kind, clip.type)) {
    badPrecondition(`a '${clip.type}' clip cannot live on a '${kind}' track`);
  }
};

const checkNoteIdsUnique = (clip: Clip): void => {
  if (clip.type !== 'midi') return;
  const seen = new Set<Id>();
  for (const n of clip.notes) {
    if (seen.has(n.id)) badPrecondition(`duplicate note id '${n.id}' in clip '${clip.id}'`);
    seen.add(n.id);
  }
};

const checkAssetRef = (ids: IdSpaces, assetId: Id | undefined, owner: string): void => {
  if (assetId !== undefined && !ids.assets.has(assetId)) {
    notFound(`${owner} references asset '${assetId}' which is not in project.assets`);
  }
};

const checkNotesLimit = (clip: Clip, limits: Limits): void => {
  if (clip.type === 'midi' && clip.notes.length > limits.maxNotesPerClip) {
    fail('limit_exceeded', `clip '${clip.id}' exceeds maxNotesPerClip (${limits.maxNotesPerClip})`);
  }
};

/**
 * True when the project routing graph (output + sends edges) contains a cycle. Edges to
 * non-existent targets are ignored; target validity is checked separately.
 */
export function hasRoutingCycle(project: Project): boolean {
  const edges = new Map<Id, Id[]>();
  for (const t of project.tracks) {
    const targets: Id[] = [];
    if (t.output !== 'master') targets.push(t.output);
    for (const s of t.sends) targets.push(s.targetTrackId);
    edges.set(t.id, targets);
  }
  const state = new Map<Id, 0 | 1 | 2>();
  const visit = (id: Id): boolean => {
    const st = state.get(id) ?? 0;
    if (st === 1) return true;
    if (st === 2) return false;
    state.set(id, 1);
    for (const target of edges.get(id) ?? []) if (visit(target)) return true;
    state.set(id, 2);
    return false;
  };
  return project.tracks.some((t) => visit(t.id));
}

const checkRoutingTarget = (project: Project, selfId: Id, targetId: Id, what: string): void => {
  if (targetId === selfId) badPrecondition(`${what} cannot route a track to itself`);
  const target = project.tracks.find((t) => t.id === targetId);
  if (!target) notFound(`${what} target track '${targetId}'`);
  if (target.kind !== 'bus') {
    badPrecondition(`${what} target '${targetId}' is a '${target.kind}' track, must be a bus`);
  }
};

/** Check nested ids of a new track payload against project id spaces (and within itself). */
function checkNewTrackIds(ids: IdSpaces, track: Track, limits: Limits): void {
  if (ids.tracks.has(track.id)) badPrecondition(`track id '${track.id}' already exists`);
  const own = { clips: new Set<Id>(), devices: new Set<Id>(), lanes: new Set<Id>() };
  const dup = (set: Set<Id>, id: Id, what: string): void => {
    if (set.has(id)) badPrecondition(`duplicate ${what} id '${id}' in new track`);
    set.add(id);
  };
  for (const clip of track.clips) {
    if (ids.clips.has(clip.id)) badPrecondition(`clip id '${clip.id}' already exists`);
    dup(own.clips, clip.id, 'clip');
    checkCompatible(track.kind, clip);
    checkNoteIdsUnique(clip);
    checkNotesLimit(clip, limits);
    if (clip.type === 'audio') checkAssetRef(ids, clip.assetId, `clip '${clip.id}'`);
  }
  const devices = [...(track.instrument ? [track.instrument] : []), ...track.effects];
  for (const d of devices) {
    if (ids.devices.has(d.id)) badPrecondition(`device id '${d.id}' already exists`);
    dup(own.devices, d.id, 'device');
    checkAssetRef(ids, d.assetId, `device '${d.id}'`);
  }
  for (const l of track.automation) {
    if (ids.lanes.has(l.id)) badPrecondition(`automation lane id '${l.id}' already exists`);
    dup(own.lanes, l.id, 'automation lane');
  }
}

/** Copy defined patch fields onto a target; `null` deletes the key when it is `nullable`. */
function applyPatch<T extends object>(
  target: T,
  patch: object,
  nullable: ReadonlySet<string>,
): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null && nullable.has(key)) {
      delete (target as Record<string, unknown>)[key];
    } else {
      (target as Record<string, unknown>)[key] = value;
    }
  }
}

const CLIP_NULLABLE = new Set(['fadeIn', 'fadeOut', 'loop']);

const requireMidi = (clip: Clip): MidiClip => {
  if (clip.type !== 'midi') {
    badPrecondition(`clip '${clip.id}' is an audio clip; MIDI operations require a MIDI clip`);
  }
  return clip;
};

const checkMapPoints = (positions: number[], what: string, unit: string): void => {
  if (positions[0] !== 0) badPrecondition(`${what} map must start at ${unit} 0`);
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] === positions[i - 1]) {
      badPrecondition(`${what} map has a duplicate ${unit} position ${positions[i]}`);
    }
    if (positions[i]! < positions[i - 1]!) {
      badPrecondition(`${what} map must be sorted by ${unit}`);
    }
  }
};

// ---------------------------------------------------------------- apply

/**
 * Pure operation application: returns a new `Project`, never mutates the input. Enforces the
 * preconditions of design §4 (not_found / precondition_failed / capability_unsupported /
 * limit_exceeded / asset_not_found / invalid_params) and validates the produced state with the
 * zod schemas (validation_failed).
 */
export function applyOperation(project: Project, op: Operation, ctx: ApplyContext): Project {
  const capability = OPERATION_CAPABILITY[op.op];
  if (!ctx.capabilities.has(capability)) {
    throw new AepError(
      'capability_unsupported',
      `operation '${op.op}' requires capability '${capability}'`,
    );
  }
  const next = structuredClone(project);
  const ids = collectIds(next);
  const tempo = next.tempo;

  switch (op.op) {
    case 'project.update': {
      const patch = parseOrFail(ProjectPatch, op.patch, 'project patch');
      applyPatch(next, patch, new Set());
      break;
    }

    case 'track.add': {
      const track = parseOrFail(Track, op.track, 'track');
      if (next.tracks.length >= ctx.limits.maxTracks) {
        fail('limit_exceeded', `maxTracks (${ctx.limits.maxTracks}) reached`);
      }
      checkNewTrackIds(ids, track, ctx.limits);
      const index = Math.min(op.index ?? next.tracks.length, next.tracks.length);
      next.tracks.splice(index, 0, track);
      break;
    }

    case 'track.update': {
      const track = next.tracks.find((t) => t.id === op.trackId);
      if (!track) notFound(`track '${op.trackId}'`, `/tracks/${op.trackId}`);
      const patch = parseOrFail(TrackPatch, op.patch, 'track patch');
      if (patch.parentId !== undefined && patch.parentId !== null) {
        if (patch.parentId === op.trackId) {
          badPrecondition('a track cannot be its own parent', `/tracks/${op.trackId}`);
        }
        if (!ids.tracks.has(patch.parentId)) notFound(`parent track '${patch.parentId}'`);
      }
      applyPatch(track, patch, new Set());
      break;
    }

    case 'track.remove': {
      const index = next.tracks.findIndex((t) => t.id === op.trackId);
      if (index < 0) notFound(`track '${op.trackId}'`, `/tracks/${op.trackId}`);
      for (const other of next.tracks) {
        if (other.id === op.trackId) continue;
        if (
          other.output === op.trackId ||
          other.parentId === op.trackId ||
          other.sends.some((s) => s.targetTrackId === op.trackId)
        ) {
          badPrecondition(
            `track '${op.trackId}' is still referenced by track '${other.id}'`,
            `/tracks/${op.trackId}`,
          );
        }
      }
      next.tracks.splice(index, 1);
      break;
    }

    case 'track.reorder': {
      const index = next.tracks.findIndex((t) => t.id === op.trackId);
      if (index < 0) notFound(`track '${op.trackId}'`, `/tracks/${op.trackId}`);
      const [track] = next.tracks.splice(index, 1);
      next.tracks.splice(Math.min(op.index, next.tracks.length), 0, track!);
      break;
    }

    case 'clip.insert': {
      const track = next.tracks.find((t) => t.id === op.trackId);
      if (!track) notFound(`track '${op.trackId}'`, `/tracks/${op.trackId}`);
      const clip = parseOrFail(Clip, op.clip, 'clip');
      if (ids.clips.has(clip.id)) badPrecondition(`clip id '${clip.id}' already exists`);
      checkCompatible(track.kind, clip);
      checkNoteIdsUnique(clip);
      checkNotesLimit(clip, ctx.limits);
      if (clip.type === 'audio') checkAssetRef(ids, clip.assetId, `clip '${clip.id}'`);
      track.clips.push(clip);
      break;
    }

    case 'clip.update': {
      const located = findClip(next, op.clipId);
      if (!located) notFound(`clip '${op.clipId}'`);
      const { clip } = located;
      const patch = parseOrFail(ClipPatch, op.patch, 'clip patch');
      if (
        (patch.sourceOffset !== undefined || patch.playbackRate !== undefined) &&
        clip.type !== 'audio'
      ) {
        badPrecondition('sourceOffset/playbackRate apply only to audio clips');
      }
      if (patch.offset !== undefined && clip.type !== 'midi') {
        badPrecondition('offset applies only to MIDI clips');
      }
      applyPatch(clip, patch, CLIP_NULLABLE);
      break;
    }

    case 'clip.remove': {
      const located = findClip(next, op.clipId);
      if (!located) notFound(`clip '${op.clipId}'`);
      located.track.clips.splice(located.index, 1);
      break;
    }

    case 'clip.move': {
      const located = findClip(next, op.clipId);
      if (!located) notFound(`clip '${op.clipId}'`);
      const target = op.trackId ? next.tracks.find((t) => t.id === op.trackId) : located.track;
      if (!target) notFound(`track '${op.trackId}'`);
      checkCompatible(target.kind, located.clip);
      if (op.start !== undefined) located.clip.start = op.start;
      if (target !== located.track) {
        located.track.clips.splice(located.index, 1);
        target.clips.push(located.clip);
      }
      break;
    }

    case 'clip.trim': {
      const located = findClip(next, op.clipId);
      if (!located) notFound(`clip '${op.clipId}'`);
      const { clip } = located;
      const end = clip.start + clip.duration;
      if (op.edge === 'start') {
        if (op.to >= end) badPrecondition('trimming the start must leave a positive duration');
        const delta = op.to - clip.start;
        if (clip.type === 'audio') {
          const deltaSeconds =
            (toSeconds(op.to, clip.timebase, tempo) - toSeconds(clip.start, clip.timebase, tempo)) *
            clip.playbackRate;
          const sourceOffset = clip.sourceOffset + deltaSeconds;
          if (sourceOffset < 0) {
            badPrecondition('trim would move sourceOffset below 0');
          }
          clip.sourceOffset = sourceOffset;
        } else {
          const offset = clip.offset + delta;
          if (offset < 0) badPrecondition('trim would move offset below 0');
          clip.offset = offset;
        }
        clip.start = op.to;
        clip.duration -= delta;
      } else {
        if (op.to <= clip.start) {
          badPrecondition('trimming the end must leave a positive duration');
        }
        clip.duration = op.to - clip.start;
      }
      break;
    }

    case 'clip.split': {
      const located = findClip(next, op.clipId);
      if (!located) notFound(`clip '${op.clipId}'`);
      const { track, clip, index } = located;
      if (ids.clips.has(op.newClipId)) {
        badPrecondition(`clip id '${op.newClipId}' already exists`);
      }
      const end = clip.start + clip.duration;
      if (op.at <= clip.start || op.at >= end) {
        badPrecondition('split point must lie strictly inside the clip');
      }
      const right: Clip = structuredClone(clip);
      right.id = op.newClipId;
      right.start = op.at;
      right.duration = end - op.at;
      delete right.fadeIn;
      delete clip.fadeOut;
      clip.duration = op.at - clip.start;
      if (clip.type === 'audio' && right.type === 'audio') {
        right.sourceOffset =
          clip.sourceOffset +
          (toSeconds(op.at, clip.timebase, tempo) - toSeconds(clip.start, clip.timebase, tempo)) *
            clip.playbackRate;
      } else if (clip.type === 'midi' && right.type === 'midi') {
        const splitSource = clip.offset + (op.at - clip.start);
        right.offset = splitSource;
        right.notes = clip.notes.filter((n) => n.start >= splitSource);
        clip.notes = clip.notes.filter((n) => n.start < splitSource);
      }
      track.clips.splice(index + 1, 0, right);
      break;
    }

    case 'clip.duplicate': {
      const located = findClip(next, op.clipId);
      if (!located) notFound(`clip '${op.clipId}'`);
      if (ids.clips.has(op.newClipId)) {
        badPrecondition(`clip id '${op.newClipId}' already exists`);
      }
      const target = op.trackId ? next.tracks.find((t) => t.id === op.trackId) : located.track;
      if (!target) notFound(`track '${op.trackId}'`);
      checkCompatible(target.kind, located.clip);
      const copy: Clip = structuredClone(located.clip);
      copy.id = op.newClipId;
      copy.start = op.start ?? located.clip.start + located.clip.duration;
      if (copy.type === 'midi') {
        const prefix = op.noteIdPrefix ?? `${op.newClipId}-`;
        copy.notes = copy.notes.map((n) => ({ ...n, id: `${prefix}${n.id}` }));
      }
      target.clips.push(copy);
      break;
    }

    case 'midi.notes.add': {
      const located = findClip(next, op.clipId);
      if (!located) notFound(`clip '${op.clipId}'`);
      const clip = requireMidi(located.clip);
      const notes = op.notes.map((n, i) => parseOrFail(Note, n, `note ${i}`));
      const existing = new Set(clip.notes.map((n) => n.id));
      for (const n of notes) {
        if (existing.has(n.id)) {
          badPrecondition(`note id '${n.id}' already exists in clip '${clip.id}'`);
        }
      }
      if (clip.notes.length + notes.length > ctx.limits.maxNotesPerClip) {
        fail('limit_exceeded', `clip '${clip.id}' exceeds maxNotesPerClip`);
      }
      clip.notes.push(...notes);
      break;
    }

    case 'midi.notes.update': {
      const located = findClip(next, op.clipId);
      if (!located) notFound(`clip '${op.clipId}'`);
      const clip = requireMidi(located.clip);
      const byId = new Map(clip.notes.map((n) => [n.id, n]));
      for (const { noteId, patch } of op.updates) {
        const note = byId.get(noteId);
        if (!note) notFound(`note '${noteId}' in clip '${clip.id}'`);
        applyPatch(note, patch, new Set());
      }
      break;
    }

    case 'midi.notes.remove': {
      const located = findClip(next, op.clipId);
      if (!located) notFound(`clip '${op.clipId}'`);
      const clip = requireMidi(located.clip);
      const existing = new Set(clip.notes.map((n) => n.id));
      for (const noteId of op.noteIds) {
        if (!existing.has(noteId)) notFound(`note '${noteId}' in clip '${clip.id}'`);
      }
      const removed = new Set(op.noteIds);
      clip.notes = clip.notes.filter((n) => !removed.has(n.id));
      break;
    }

    case 'midi.events.update': {
      const located = findClip(next, op.clipId);
      if (!located) notFound(`clip '${op.clipId}'`);
      const clip = requireMidi(located.clip);
      if (op.controllers !== undefined) {
        clip.controllers = op.controllers.map((c, i) =>
          parseOrFail(ControllerEvent, c, `controller ${i}`),
        );
      }
      if (op.pitchBends !== undefined) {
        clip.pitchBends = op.pitchBends.map((b, i) =>
          parseOrFail(PitchBendEvent, b, `pitch bend ${i}`),
        );
      }
      break;
    }

    case 'tempo.update': {
      const points = op.tempo.map((p, i) => parseOrFail(TempoPoint, p, `tempo point ${i}`));
      if (points.length === 0) badPrecondition('tempo map must not be empty');
      checkMapPoints(
        points.map((p) => p.beat),
        'tempo',
        'beat',
      );
      next.tempo = points;
      break;
    }

    case 'meter.update': {
      const points = op.meter.map((p, i) => parseOrFail(MeterPoint, p, `meter point ${i}`));
      if (points.length === 0) badPrecondition('meter map must not be empty');
      checkMapPoints(
        points.map((p) => p.bar),
        'meter',
        'bar',
      );
      next.meter = points;
      break;
    }

    case 'section.add': {
      const section = parseOrFail(Section, op.section, 'section');
      if (ids.sections.has(section.id)) {
        badPrecondition(`section id '${section.id}' already exists`);
      }
      next.sections.push(section);
      break;
    }

    case 'section.update': {
      const section = next.sections.find((s) => s.id === op.sectionId);
      if (!section) notFound(`section '${op.sectionId}'`, `/sections/${op.sectionId}`);
      applyPatch(section, parseOrFail(SectionPatch, op.patch, 'section patch'), new Set());
      break;
    }

    case 'section.remove': {
      const index = next.sections.findIndex((s) => s.id === op.sectionId);
      if (index < 0) notFound(`section '${op.sectionId}'`, `/sections/${op.sectionId}`);
      next.sections.splice(index, 1);
      break;
    }

    case 'routing.update': {
      const track = next.tracks.find((t) => t.id === op.trackId);
      if (!track) notFound(`track '${op.trackId}'`, `/tracks/${op.trackId}`);
      if (op.output !== undefined) {
        if (op.output !== 'master') checkRoutingTarget(next, track.id, op.output, 'output');
        track.output = op.output;
      }
      if (op.sends !== undefined) {
        for (const send of op.sends) {
          checkRoutingTarget(next, track.id, send.targetTrackId, 'send');
        }
        track.sends = structuredClone(op.sends);
      }
      if (hasRoutingCycle(next)) {
        badPrecondition('routing change would create a cycle', `/tracks/${op.trackId}`);
      }
      break;
    }

    case 'instrument.set': {
      const track = next.tracks.find((t) => t.id === op.trackId);
      if (!track) notFound(`track '${op.trackId}'`, `/tracks/${op.trackId}`);
      if (op.instrument === null) {
        track.instrument = null;
      } else {
        const device = parseOrFail(Device, op.instrument, 'instrument');
        if (ids.devices.has(device.id) && track.instrument?.id !== device.id) {
          badPrecondition(`device id '${device.id}' already exists`);
        }
        checkAssetRef(ids, device.assetId, `instrument '${device.id}'`);
        track.instrument = device;
      }
      break;
    }

    case 'effect.insert': {
      const track = next.tracks.find((t) => t.id === op.trackId);
      if (!track) notFound(`track '${op.trackId}'`, `/tracks/${op.trackId}`);
      const device = parseOrFail(Device, op.effect, 'effect');
      if (ids.devices.has(device.id)) {
        badPrecondition(`device id '${device.id}' already exists`);
      }
      checkAssetRef(ids, device.assetId, `effect '${device.id}'`);
      const index = Math.min(op.index ?? track.effects.length, track.effects.length);
      track.effects.splice(index, 0, device);
      break;
    }

    case 'effect.update': {
      const located = findDevice(next, op.deviceId);
      if (!located) notFound(`device '${op.deviceId}'`);
      const patch = parseOrFail(DevicePatch, op.patch, 'device patch');
      const { device } = located;
      if (patch.name !== undefined) device.name = patch.name;
      if (patch.bypass !== undefined) device.bypass = patch.bypass;
      if (patch.extensions !== undefined) device.extensions = patch.extensions;
      if (patch.parameters !== undefined) {
        for (const [key, value] of Object.entries(patch.parameters)) {
          if (value === null) delete device.parameters[key];
          else device.parameters[key] = value;
        }
      }
      break;
    }

    case 'effect.remove': {
      const located = findDevice(next, op.deviceId);
      if (!located) notFound(`device '${op.deviceId}'`);
      if (located.where === 'instrument') {
        badPrecondition(`device '${op.deviceId}' is an instrument; use instrument.set null`);
      }
      located.track.effects.splice(located.index, 1);
      break;
    }

    case 'automation.lane.add': {
      const track = next.tracks.find((t) => t.id === op.trackId);
      if (!track) notFound(`track '${op.trackId}'`, `/tracks/${op.trackId}`);
      const lane = parseOrFail(AutomationLane, op.lane, 'automation lane');
      if (ids.lanes.has(lane.id)) {
        badPrecondition(`automation lane id '${lane.id}' already exists`);
      }
      if (lane.target.kind === 'device') {
        const located = findDevice(next, lane.target.deviceId);
        if (!located) notFound(`device '${lane.target.deviceId}'`);
        if (located.track.id !== track.id) {
          badPrecondition(
            `automation target device '${lane.target.deviceId}' is not on track '${track.id}'`,
          );
        }
      }
      track.automation.push(lane);
      break;
    }

    case 'automation.points.update': {
      const located = findLane(next, op.laneId);
      if (!located) notFound(`automation lane '${op.laneId}'`);
      const { lane } = located;
      const points = op.points
        .map((p, i) => parseOrFail(AutomationPoint, p, `automation point ${i}`))
        .sort((a, b) => a.time - b.time);
      const kept = op.range
        ? lane.points.filter((p) => !(p.time >= op.range!.start && p.time < op.range!.end))
        : [];
      const merged = [...kept, ...points].sort((a, b) => a.time - b.time);
      for (let i = 1; i < merged.length; i++) {
        if (merged[i]!.time === merged[i - 1]!.time) {
          badPrecondition(`duplicate automation point time ${merged[i]!.time}`);
        }
      }
      lane.points = merged;
      break;
    }

    case 'automation.lane.remove': {
      const located = findLane(next, op.laneId);
      if (!located) notFound(`automation lane '${op.laneId}'`);
      located.track.automation.splice(located.index, 1);
      break;
    }

    case 'asset.link': {
      if (ids.assets.has(op.assetId)) {
        badPrecondition(`asset '${op.assetId}' is already linked into the project`);
      }
      const asset = ctx.lookupStoreAsset(op.assetId);
      if (!asset) {
        throw new AepError('asset_not_found', `asset '${op.assetId}' is not in the host store`);
      }
      next.assets.push(structuredClone(asset));
      break;
    }

    case 'asset.unlink': {
      const index = next.assets.findIndex((a) => a.id === op.assetId);
      if (index < 0) notFound(`project asset '${op.assetId}'`, `/assets/${op.assetId}`);
      for (const track of next.tracks) {
        if (track.instrument?.assetId === op.assetId) {
          badPrecondition(`asset '${op.assetId}' is referenced by device '${track.instrument.id}'`);
        }
        for (const d of track.effects) {
          if (d.assetId === op.assetId) {
            badPrecondition(`asset '${op.assetId}' is referenced by device '${d.id}'`);
          }
        }
        for (const c of track.clips) {
          if (c.type === 'audio' && c.assetId === op.assetId) {
            badPrecondition(`asset '${op.assetId}' is referenced by clip '${c.id}'`);
          }
        }
      }
      next.assets.splice(index, 1);
      break;
    }
  }

  const parsed = Project.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AepError(
      'validation_failed',
      `operation '${op.op}' produced invalid project state: ${issue?.message ?? 'invalid'}`,
      parsed.error.issues.slice(0, 8).map((i) => ({
        code: 'validation_failed',
        message: i.message,
        path: `/${i.path.join('/')}`,
      })),
    );
  }
  return parsed.data;
}

/** Best-effort entity path for an operation's primary target, for diagnostics. */
function entityPathForOp(project: Project, op: Operation): string | undefined {
  switch (op.op) {
    case 'project.update':
      return '/project';
    case 'tempo.update':
      return '/tempo';
    case 'meter.update':
      return '/meter';
    case 'track.add':
      return `/tracks/${op.track.id}`;
    case 'track.update':
    case 'track.remove':
    case 'track.reorder':
    case 'routing.update':
    case 'instrument.set':
    case 'effect.insert':
    case 'automation.lane.add':
    case 'clip.insert':
      return `/tracks/${op.trackId}`;
    case 'clip.update':
    case 'clip.remove':
    case 'clip.move':
    case 'clip.trim':
    case 'clip.split':
    case 'clip.duplicate':
    case 'midi.notes.add':
    case 'midi.notes.update':
    case 'midi.notes.remove':
    case 'midi.events.update': {
      const located = findClip(project, op.clipId);
      return located ? `/tracks/${located.track.id}/clips/${op.clipId}` : undefined;
    }
    case 'section.add':
      return `/sections/${op.section.id}`;
    case 'section.update':
    case 'section.remove':
      return `/sections/${op.sectionId}`;
    case 'effect.update':
    case 'effect.remove': {
      const located = findDevice(project, op.deviceId);
      if (!located) return undefined;
      return located.where === 'instrument'
        ? `/tracks/${located.track.id}/instrument`
        : `/tracks/${located.track.id}/effects/${op.deviceId}`;
    }
    case 'automation.points.update':
    case 'automation.lane.remove': {
      const located = findLane(project, op.laneId);
      return located ? `/tracks/${located.track.id}/automation/${op.laneId}` : undefined;
    }
    case 'asset.link':
    case 'asset.unlink':
      return `/assets/${op.assetId}`;
  }
}

/**
 * Apply a list of operations in order. Any failure aborts the list and is rethrown as an
 * `AepError` carrying a diagnostic with `operationIndex` (and the entity path when known).
 */
export function applyOperations(
  project: Project,
  ops: readonly Operation[],
  ctx: ApplyContext,
): Project {
  let current = project;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    try {
      current = applyOperation(current, op, ctx);
    } catch (e) {
      const err = isAepError(e)
        ? e
        : // Never surface raw exception text: it can carry host internals.
          new AepError('internal_error', 'internal error while applying operation');
      const path = entityPathForOp(current, op);
      const diagnostic: Diagnostic = {
        code: err.code,
        message: err.message,
        operationIndex: i,
        ...(path !== undefined ? { path } : {}),
      };
      throw new AepError(err.code, `operation ${i} (${op.op}): ${err.message}`, [
        diagnostic,
        ...err.diagnostics,
      ]);
    }
  }
  return current;
}
