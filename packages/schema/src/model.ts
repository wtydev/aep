/**
 * AEP Audio Domain — portable logical project model (interchange and editing model, not a
 * storage format). See specs/audio/AUDIO-DOMAIN.md for normative semantics.
 */
import { z } from 'zod';
import {
  Extensions,
  GainDb,
  Id,
  Pan,
  ParamValue,
  RevisionId,
  Timebase,
  finite,
  nonNegative,
  positive,
} from './common.js';

const int = (min: number, max: number) => z.number().int().min(min).max(max);

// ---------------------------------------------------------------- tempo / meter / sections

/**
 * Tempo segment start. `curve` shapes the segment from this point to the next: `step` keeps
 * `bpm` constant; `linear` ramps bpm linearly in beats to the next point's `bpm`. The last
 * point's curve has no effect (tempo stays at its `bpm`).
 */
export const TempoPoint = z.strictObject({
  beat: nonNegative(),
  bpm: z.number().finite().min(1).max(999),
  curve: z.enum(['step', 'linear']).default('step'),
});
export type TempoPoint = z.infer<typeof TempoPoint>;

/** Meter change anchored at a 0-based bar index. */
export const MeterPoint = z.strictObject({
  bar: z.number().int().min(0),
  numerator: int(1, 64),
  denominator: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(4),
    z.literal(8),
    z.literal(16),
    z.literal(32),
  ]),
});
export type MeterPoint = z.infer<typeof MeterPoint>;

/** Arrangement section (marker range). Always musical time. */
export const Section = z.strictObject({
  id: Id,
  name: z.string().max(256),
  start: nonNegative(),
  duration: positive(),
  timebase: Timebase.default('beats'),
  color: z.string().max(32).optional(),
  extensions: Extensions.optional(),
});
export type Section = z.infer<typeof Section>;

// ---------------------------------------------------------------- assets

export const AssetAvailability = z.enum(['available', 'missing', 'pending']);

export const Provenance = z.strictObject({
  /** Generator, recipe or tool id that produced the asset, e.g. `com.example.sfx/whoosh@1`. */
  generator: z.string().max(256).optional(),
  generatorVersion: z.string().max(64).optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  seed: z.number().int().optional(),
  /** Renderer / engine identification for reproducibility. */
  engine: z.record(z.string(), z.string().max(256)).optional(),
  /** Project revision the asset was derived from, if any. */
  sourceRevision: RevisionId.optional(),
  createdAt: z.iso.datetime().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

/**
 * Logical media asset. Identity (`id`, `contentHash`) is distinct from transport/location: the
 * host resolves `id` to bytes. Clients never see host filesystem paths.
 */
export const Asset = z.strictObject({
  id: Id,
  name: z.string().max(256).optional(),
  mediaType: z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/, 'must be a media type like audio/wav'),
  /** `sha256:<64 hex>` of the asset bytes when known. */
  contentHash: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .optional(),
  byteLength: z.number().int().min(0).optional(),
  durationSeconds: nonNegative().optional(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().min(1).max(64).optional(),
  availability: AssetAvailability,
  /** `portable`: identified by content hash, resolvable by any host holding the bytes. `host-local`: only meaningful to this host. */
  portability: z.enum(['portable', 'host-local']).default('host-local'),
  provenance: Provenance.optional(),
  extensions: Extensions.optional(),
});
export type Asset = z.infer<typeof Asset>;

// ---------------------------------------------------------------- devices (instruments, effects)

/**
 * A logical device instance (instrument or effect). `type` is a namespaced device type
 * (`aep.gain`, `aep.eq`, `aep.soundfont`, `com.vendor.reverb`). AEP does not standardize plugin
 * binaries; plugin state belongs in `extensions`.
 */
export const Device = z.strictObject({
  id: Id,
  type: z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/),
  name: z.string().max(256).optional(),
  bypass: z.boolean().default(false),
  parameters: z.record(z.string().max(128), ParamValue).default({}),
  /** Asset used by the device (e.g. a SoundFont), if any. */
  assetId: Id.optional(),
  extensions: Extensions.optional(),
});
export type Device = z.infer<typeof Device>;

// ---------------------------------------------------------------- automation

export const AutomationTarget = z.union([
  z.strictObject({ kind: z.literal('track'), parameter: z.enum(['gainDb', 'pan']) }),
  z.strictObject({
    kind: z.literal('device'),
    deviceId: Id,
    parameter: z.string().min(1).max(128),
  }),
]);
export type AutomationTarget = z.infer<typeof AutomationTarget>;

export const AutomationPoint = z.strictObject({
  time: nonNegative(),
  value: finite(),
  /** Interpolation from this point to the next. */
  curve: z.enum(['step', 'linear', 'exponential']).default('linear'),
});
export type AutomationPoint = z.infer<typeof AutomationPoint>;

export const AutomationLane = z.strictObject({
  id: Id,
  target: AutomationTarget,
  timebase: Timebase.default('beats'),
  min: finite().optional(),
  max: finite().optional(),
  /** Sorted by `time`; at most one point per time value. */
  points: z.array(AutomationPoint).default([]),
  extensions: Extensions.optional(),
});
export type AutomationLane = z.infer<typeof AutomationLane>;

// ---------------------------------------------------------------- MIDI

/** MIDI note. `start`/`duration` are in the parent clip's source coordinates (clip timebase). */
export const Note = z.strictObject({
  id: Id,
  pitch: int(0, 127),
  start: nonNegative(),
  duration: positive(),
  velocity: int(1, 127),
  /** 0-based MIDI channel (0–15). */
  channel: int(0, 15).default(0),
  releaseVelocity: int(0, 127).optional(),
});
export type Note = z.infer<typeof Note>;

/** Control change (CC 0–127). */
export const ControllerEvent = z.strictObject({
  time: nonNegative(),
  controller: int(0, 127),
  value: int(0, 127),
  channel: int(0, 15).default(0),
});
export type ControllerEvent = z.infer<typeof ControllerEvent>;

/** 14-bit pitch bend, -8192..8191 (MIDI 1.0 value minus 8192). */
export const PitchBendEvent = z.strictObject({
  time: nonNegative(),
  value: int(-8192, 8191),
  channel: int(0, 15).default(0),
});
export type PitchBendEvent = z.infer<typeof PitchBendEvent>;

// ---------------------------------------------------------------- clips

export const Fade = z.strictObject({
  /** In the clip's timebase units. */
  duration: nonNegative(),
  curve: z.enum(['linear', 'equal-power', 'exponential']).default('linear'),
});

/**
 * Clip loop. The looped source region is `[start, start + length)`, where `start` is the clip's
 * `sourceOffset` (audio) or `offset` (MIDI). `length` is in source units: seconds of the source
 * asset for audio clips, the clip's timebase for MIDI clips.
 */
export const ClipLoop = z.strictObject({ enabled: z.boolean(), length: positive() });
export type ClipLoop = z.infer<typeof ClipLoop>;

const ClipCommon = {
  id: Id,
  name: z.string().max(256).optional(),
  /** Timeline position of the clip start, in `timebase` units. */
  start: nonNegative(),
  /** Timeline length, in `timebase` units. */
  duration: positive(),
  timebase: Timebase,
  muted: z.boolean().default(false),
  gainDb: GainDb.default(0),
  fadeIn: Fade.optional(),
  fadeOut: Fade.optional(),
  extensions: Extensions.optional(),
};

/**
 * Audio clip. Source position = `sourceOffset + clipLocalSeconds * playbackRate` (seconds of the
 * source asset), wrapped by `loop.length` when looping.
 */
export const AudioClip = z.strictObject({
  ...ClipCommon,
  type: z.literal('audio'),
  assetId: Id,
  sourceOffset: nonNegative().default(0),
  playbackRate: z.number().finite().min(0.01).max(100).default(1),
  loop: ClipLoop.optional(),
});
export type AudioClip = z.infer<typeof AudioClip>;

/**
 * MIDI clip. Notes and events are stored in source coordinates (clip timebase). The clip window
 * shows source range `[offset, offset + duration)`; source position = `offset + clipLocal`.
 */
export const MidiClip = z.strictObject({
  ...ClipCommon,
  type: z.literal('midi'),
  offset: nonNegative().default(0),
  loop: ClipLoop.optional(),
  notes: z.array(Note).default([]),
  controllers: z.array(ControllerEvent).default([]),
  pitchBends: z.array(PitchBendEvent).default([]),
});
export type MidiClip = z.infer<typeof MidiClip>;

export const Clip = z.discriminatedUnion('type', [AudioClip, MidiClip]);
export type Clip = z.infer<typeof Clip>;

// ---------------------------------------------------------------- tracks

export const TrackKind = z.enum(['audio', 'instrument', 'midi', 'bus', 'hybrid']);
export type TrackKind = z.infer<typeof TrackKind>;

export const Send = z.strictObject({
  targetTrackId: Id,
  gainDb: GainDb.default(0),
  preFader: z.boolean().default(false),
});

export const Track = z.strictObject({
  id: Id,
  name: z.string().max(256),
  kind: TrackKind,
  /** Parent folder/group track, when the host supports hierarchy. */
  parentId: Id.nullable().default(null),
  mute: z.boolean().default(false),
  solo: z.boolean().default(false),
  gainDb: GainDb.default(0),
  pan: Pan.default(0),
  channels: z.number().int().min(1).max(64).default(2),
  /** Output routing: a bus track id, or `master`. */
  output: z.union([z.literal('master'), Id]).default('master'),
  sends: z.array(Send).default([]),
  instrument: Device.nullable().default(null),
  /** Ordered effect chain (signal order). */
  effects: z.array(Device).default([]),
  clips: z.array(Clip).default([]),
  automation: z.array(AutomationLane).default([]),
  extensions: Extensions.optional(),
});
export type Track = z.infer<typeof Track>;

// ---------------------------------------------------------------- project

export const Project = z.strictObject({
  /** Doubles as the envelope `workspace` id, hence the stricter charset. */
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  name: z.string().max(256).default(''),
  metadata: z
    .record(z.string().max(128), z.union([z.string().max(4096), z.number(), z.boolean()]))
    .default({}),
  /** Host/project sample rate when known. Required to convert to/from samples. */
  sampleRate: z.number().int().min(8000).max(768000).optional(),
  /** Sorted by beat; first point MUST be at beat 0. */
  tempo: z
    .array(TempoPoint)
    .min(1)
    .default([{ beat: 0, bpm: 120, curve: 'step' }]),
  /** Sorted by bar; first point MUST be at bar 0. */
  meter: z
    .array(MeterPoint)
    .min(1)
    .default([{ bar: 0, numerator: 4, denominator: 4 }]),
  /** Ordered top-to-bottom. */
  tracks: z.array(Track).default([]),
  sections: z.array(Section).default([]),
  assets: z.array(Asset).default([]),
  extensions: Extensions.optional(),
});
export type Project = z.infer<typeof Project>;
/** Input shape (defaults optional). */
export type ProjectInput = z.input<typeof Project>;
