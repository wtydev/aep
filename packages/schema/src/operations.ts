/**
 * AEP Audio Domain operations. Operations only appear inside a transaction
 * (`transaction.commit`, `transaction.validate`, `proposal.create`). Property changes use typed
 * patches instead of one setter per property.
 */
import { z } from 'zod';
import { Extensions, GainDb, Id, Pan, ParamValue, nonNegative, positive } from './common.js';
import {
  AutomationLane,
  AutomationPoint,
  Clip,
  ControllerEvent,
  Device,
  Fade,
  MeterPoint,
  Note,
  PitchBendEvent,
  Section,
  Send,
  TempoPoint,
  Track,
  TrackKind,
} from './model.js';

const op = <T extends string, S extends z.ZodRawShape>(name: T, shape: S) =>
  z.strictObject({ op: z.literal(name), ...shape });

// ---- patches (strict: only editable properties) -------------------------------------------

export const ProjectPatch = z
  .strictObject({
    name: z.string().max(256),
    metadata: z.record(
      z.string().max(128),
      z.union([z.string().max(4096), z.number(), z.boolean()]),
    ),
    sampleRate: z.number().int().min(8000).max(768000),
    extensions: Extensions,
  })
  .partial();

export const TrackPatch = z
  .strictObject({
    name: z.string().max(256),
    kind: TrackKind,
    parentId: Id.nullable(),
    mute: z.boolean(),
    solo: z.boolean(),
    gainDb: GainDb,
    pan: Pan,
    channels: z.number().int().min(1).max(64),
    extensions: Extensions,
  })
  .partial();

export const ClipPatch = z
  .strictObject({
    name: z.string().max(256),
    duration: positive(),
    muted: z.boolean(),
    gainDb: GainDb,
    fadeIn: Fade.nullable(),
    fadeOut: Fade.nullable(),
    /** audio clips only */
    sourceOffset: nonNegative(),
    playbackRate: z.number().finite().min(0.01).max(100),
    /** midi clips only */
    offset: nonNegative(),
    loop: z.strictObject({ enabled: z.boolean(), length: positive() }).nullable(),
    extensions: Extensions,
  })
  .partial();

export const NotePatch = z
  .strictObject({
    pitch: z.number().int().min(0).max(127),
    start: nonNegative(),
    duration: positive(),
    velocity: z.number().int().min(1).max(127),
    channel: z.number().int().min(0).max(15),
    releaseVelocity: z.number().int().min(0).max(127),
  })
  .partial();

export const DevicePatch = z
  .strictObject({
    name: z.string().max(256),
    bypass: z.boolean(),
    /** Merged into existing parameters; `null` removes a parameter. */
    parameters: z.record(z.string().max(128), ParamValue.nullable()),
    extensions: Extensions,
  })
  .partial();

export const SectionPatch = z
  .strictObject({
    name: z.string().max(256),
    start: nonNegative(),
    duration: positive(),
    color: z.string().max(32),
  })
  .partial();

// ---- operations ---------------------------------------------------------------------------

export const ProjectUpdate = op('project.update', { patch: ProjectPatch });

export const TrackAdd = op('track.add', {
  track: Track,
  /** Insert position in the track order; default end. */
  index: z.number().int().min(0).optional(),
});
export const TrackUpdate = op('track.update', { trackId: Id, patch: TrackPatch });
export const TrackRemove = op('track.remove', { trackId: Id });
export const TrackReorder = op('track.reorder', { trackId: Id, index: z.number().int().min(0) });

export const ClipInsert = op('clip.insert', { trackId: Id, clip: Clip });
export const ClipUpdate = op('clip.update', { clipId: Id, patch: ClipPatch });
export const ClipRemove = op('clip.remove', { clipId: Id });
export const ClipMove = op('clip.move', {
  clipId: Id,
  /** New timeline start in the clip's timebase. Omit to keep. */
  start: nonNegative().optional(),
  /** Destination track. Omit to keep. */
  trackId: Id.optional(),
});
export const ClipTrim = op('clip.trim', {
  clipId: Id,
  edge: z.enum(['start', 'end']),
  /** New timeline position of the trimmed edge, in the clip's timebase. */
  to: nonNegative(),
});
export const ClipSplit = op('clip.split', {
  clipId: Id,
  /** Timeline position (clip timebase) strictly inside the clip. */
  at: positive(),
  /** Id for the right-hand clip. */
  newClipId: Id,
});
export const ClipDuplicate = op('clip.duplicate', {
  clipId: Id,
  newClipId: Id,
  /** Default: immediately after the source clip. */
  start: nonNegative().optional(),
  trackId: Id.optional(),
  /** Prefix used to derive new note ids (`<prefix><oldId>`); default `<newClipId>-`. */
  noteIdPrefix: z
    .string()
    .max(64)
    .regex(/^[A-Za-z0-9._:-]*$/)
    .optional(),
});

export const MidiNotesAdd = op('midi.notes.add', { clipId: Id, notes: z.array(Note).min(1) });
export const MidiNotesUpdate = op('midi.notes.update', {
  clipId: Id,
  updates: z.array(z.strictObject({ noteId: Id, patch: NotePatch })).min(1),
});
export const MidiNotesRemove = op('midi.notes.remove', { clipId: Id, noteIds: z.array(Id).min(1) });
/** Replaces the whole controller and/or pitch-bend lists of a clip. */
export const MidiEventsUpdate = op('midi.events.update', {
  clipId: Id,
  controllers: z.array(ControllerEvent).optional(),
  pitchBends: z.array(PitchBendEvent).optional(),
});

export const TempoUpdate = op('tempo.update', { tempo: z.array(TempoPoint).min(1) });
export const MeterUpdate = op('meter.update', { meter: z.array(MeterPoint).min(1) });

export const SectionAdd = op('section.add', { section: Section });
export const SectionUpdate = op('section.update', { sectionId: Id, patch: SectionPatch });
export const SectionRemove = op('section.remove', { sectionId: Id });

export const RoutingUpdate = op('routing.update', {
  trackId: Id,
  output: z.union([z.literal('master'), Id]).optional(),
  sends: z.array(Send).optional(),
});

export const InstrumentSet = op('instrument.set', { trackId: Id, instrument: Device.nullable() });
export const EffectInsert = op('effect.insert', {
  trackId: Id,
  effect: Device,
  index: z.number().int().min(0).optional(),
});
export const EffectUpdate = op('effect.update', { deviceId: Id, patch: DevicePatch });
export const EffectRemove = op('effect.remove', { deviceId: Id });

export const AutomationLaneAdd = op('automation.lane.add', { trackId: Id, lane: AutomationLane });
export const AutomationPointsUpdate = op('automation.points.update', {
  laneId: Id,
  /** Replace points with `range.start <= time < range.end`; omit to replace all points. */
  range: z.strictObject({ start: nonNegative(), end: positive() }).optional(),
  points: z.array(AutomationPoint),
});
export const AutomationLaneRemove = op('automation.lane.remove', { laneId: Id });

/** Link a host-store asset (from `asset.import` or a job result) into the project. */
export const AssetLink = op('asset.link', { assetId: Id });
export const AssetUnlink = op('asset.unlink', { assetId: Id });

export const Operation = z.discriminatedUnion('op', [
  ProjectUpdate,
  TrackAdd,
  TrackUpdate,
  TrackRemove,
  TrackReorder,
  ClipInsert,
  ClipUpdate,
  ClipRemove,
  ClipMove,
  ClipTrim,
  ClipSplit,
  ClipDuplicate,
  MidiNotesAdd,
  MidiNotesUpdate,
  MidiNotesRemove,
  MidiEventsUpdate,
  TempoUpdate,
  MeterUpdate,
  SectionAdd,
  SectionUpdate,
  SectionRemove,
  RoutingUpdate,
  InstrumentSet,
  EffectInsert,
  EffectUpdate,
  EffectRemove,
  AutomationLaneAdd,
  AutomationPointsUpdate,
  AutomationLaneRemove,
  AssetLink,
  AssetUnlink,
]);
export type Operation = z.infer<typeof Operation>;
export type OperationName = Operation['op'];
export type OperationOf<N extends OperationName> = Extract<Operation, { op: N }>;

export const OPERATION_NAMES = Operation.options.map((o) => o.shape.op.value) as OperationName[];
export const OperationNameSchema = z.enum(OPERATION_NAMES as [OperationName, ...OperationName[]]);

/** Capability each operation requires. Hosts advertise capabilities; ops outside them are rejected. */
export const OPERATION_CAPABILITY: Record<OperationName, string> = {
  'project.update': 'aep.audio.project',
  'track.add': 'aep.audio.tracks',
  'track.update': 'aep.audio.tracks',
  'track.remove': 'aep.audio.tracks',
  'track.reorder': 'aep.audio.tracks',
  'clip.insert': 'aep.audio.clips',
  'clip.update': 'aep.audio.clips',
  'clip.remove': 'aep.audio.clips',
  'clip.move': 'aep.audio.clips',
  'clip.trim': 'aep.audio.clips',
  'clip.split': 'aep.audio.clips',
  'clip.duplicate': 'aep.audio.clips',
  'midi.notes.add': 'aep.audio.midi',
  'midi.notes.update': 'aep.audio.midi',
  'midi.notes.remove': 'aep.audio.midi',
  'midi.events.update': 'aep.audio.midi',
  'tempo.update': 'aep.audio.tempo',
  'meter.update': 'aep.audio.tempo',
  'section.add': 'aep.audio.sections',
  'section.update': 'aep.audio.sections',
  'section.remove': 'aep.audio.sections',
  'routing.update': 'aep.audio.routing',
  'instrument.set': 'aep.audio.devices',
  'effect.insert': 'aep.audio.devices',
  'effect.update': 'aep.audio.devices',
  'effect.remove': 'aep.audio.devices',
  'automation.lane.add': 'aep.audio.automation',
  'automation.points.update': 'aep.audio.automation',
  'automation.lane.remove': 'aep.audio.automation',
  'asset.link': 'aep.audio.assets',
  'asset.unlink': 'aep.audio.assets',
};
