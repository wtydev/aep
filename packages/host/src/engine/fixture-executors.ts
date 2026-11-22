/**
 * TEST DOUBLES — not audio.
 *
 * These executors exist only to exercise the job lifecycle (design §10). The "renderer" writes a
 * JSON description of what *would* be rendered and produces no audio; the "generator" emits
 * deterministic `midi.notes.add` operations from a seeded PRNG and is not a composition model.
 * Neither performs DSP, calls an AI provider, or runs project-supplied code.
 */
import { canonicalJson } from '@wty.dev/aep-core';
import { beatsToSeconds, unitToSeconds } from '@wty.dev/aep-schema';
import type { Diagnostic, MidiClip, Note, Operation, Project } from '@wty.dev/aep-schema';
import type { ExecutorDescription, JobContext, JobExecutor, JobInput, JobOutput } from './jobs.js';

export const MANIFEST_RENDERER_ID = 'aep.reference.manifest-renderer';
export const PATTERN_GENERATOR_ID = 'aep.reference.pattern';
export const RENDER_MANIFEST_MEDIA_TYPE = 'application/vnd.aep.render-manifest+json';

/** Small, fast, seedable 32-bit PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clipEndSeconds = (project: Project, start: number, duration: number, tb: string): number =>
  tb === 'seconds' ? start + duration : beatsToSeconds(start + duration, project.tempo);
const clipStartSeconds = (project: Project, start: number, tb: string): number =>
  tb === 'seconds' ? start : beatsToSeconds(start, project.tempo);

/** TEST DOUBLE render "engine": emits a manifest asset describing the snapshot, no audio. */
export class ManifestRenderer implements JobExecutor {
  readonly kind = 'render' as const;
  readonly id = MANIFEST_RENDERER_ID;

  describe(): ExecutorDescription {
    return {
      name: 'Reference render-manifest writer (test double, no audio)',
      outputs: ['audio'],
      deterministic: true,
    };
  }

  async run(input: JobInput, ctx: JobContext): Promise<JobOutput> {
    if (input.kind !== 'render') throw new Error('manifest-renderer only handles render jobs');
    const { project, params } = input;
    ctx.progress(0.1);
    const wanted = params.trackIds ? new Set(params.trackIds) : undefined;
    const range = params.range
      ? {
          start: unitToSeconds(
            params.range.start,
            params.range.unit,
            project.tempo,
            project.sampleRate,
          ),
          end: unitToSeconds(
            params.range.end,
            params.range.unit,
            project.tempo,
            project.sampleRate,
          ),
        }
      : undefined;
    const tracks = project.tracks
      .filter((t) => !wanted || wanted.has(t.id))
      .map((t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        clips: t.clips
          .map((c) => ({
            id: c.id,
            type: c.type,
            startSeconds: clipStartSeconds(project, c.start, c.timebase),
            endSeconds: clipEndSeconds(project, c.start, c.duration, c.timebase),
            ...(c.type === 'audio' ? { assetId: c.assetId } : { noteCount: c.notes.length }),
          }))
          .filter((c) => !range || (c.endSeconds > range.start && c.startSeconds < range.end)),
      }));
    const manifest = {
      kind: 'aep.render-manifest',
      testDouble: true,
      note: 'Describes what would be rendered. Contains no audio.',
      projectId: project.id,
      revision: input.revision,
      ...(input.proposalId !== undefined ? { proposalId: input.proposalId } : {}),
      target: params.target,
      format: params.format,
      preview: params.preview,
      ...(range ? { range } : {}),
      sampleRate: project.sampleRate ?? null,
      tempo: project.tempo,
      tracks,
    };
    ctx.progress(0.8);
    const asset = ctx.putAsset(new TextEncoder().encode(canonicalJson(manifest)), {
      name: `render-manifest-${input.revision}.json`,
      mediaType: RENDER_MANIFEST_MEDIA_TYPE,
      provenance: {
        generator: MANIFEST_RENDERER_ID,
        sourceRevision: input.revision,
        engine: { name: 'aep-reference-test-double' },
      },
    });
    return { assets: [asset], reproducibility: { target: params.target } };
  }
}

interface PatternParameters {
  pitches: number[];
  stepBeats: number;
  count: number;
  velocity?: number;
  clipId?: string;
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function readParameters(raw: Record<string, unknown>): {
  value?: PatternParameters;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const bad = (path: string, message: string): void => {
    diagnostics.push({ code: 'invalid_params', message, path: `/parameters/${path}` });
  };
  const { pitches, stepBeats, count, velocity, clipId, ...rest } = raw;
  for (const k of Object.keys(rest)) bad(k, `unknown parameter '${k}'`);
  if (
    !Array.isArray(pitches) ||
    pitches.length < 1 ||
    pitches.length > 128 ||
    !pitches.every((p) => isInt(p, 0, 127))
  ) {
    bad('pitches', 'pitches must be 1..128 integers in 0..127');
  }
  if (typeof stepBeats !== 'number' || !Number.isFinite(stepBeats) || stepBeats <= 0) {
    bad('stepBeats', 'stepBeats must be a positive number');
  }
  if (!isInt(count, 1, 1024)) bad('count', 'count must be an integer in 1..1024');
  if (velocity !== undefined && !isInt(velocity, 1, 127))
    bad('velocity', 'velocity must be an integer in 1..127');
  if (clipId !== undefined && typeof clipId !== 'string') bad('clipId', 'clipId must be a string');
  if (diagnostics.length > 0) return { diagnostics };
  return {
    diagnostics,
    value: {
      pitches: pitches as number[],
      stepBeats: stepBeats as number,
      count: count as number,
      ...(velocity !== undefined ? { velocity: velocity as number } : {}),
      ...(clipId !== undefined ? { clipId: clipId as string } : {}),
    },
  };
}

function findTargetClip(
  project: Project,
  params: PatternParameters,
  trackId?: string,
): MidiClip | undefined {
  const midiClips = project.tracks
    .filter((t) => trackId === undefined || t.id === trackId)
    .flatMap((t) => t.clips)
    .filter((c): c is MidiClip => c.type === 'midi');
  return params.clipId !== undefined ? midiClips.find((c) => c.id === params.clipId) : midiClips[0];
}

/**
 * TEST DOUBLE generator: deterministic notes from `{pitches, stepBeats, count, velocity?}` and
 * `seed` (default 0). Target clip = `parameters.clipId`, else the first MIDI clip on
 * `target.trackId`, else the first MIDI clip in the project. Output is a single
 * `midi.notes.add` operation; note ids are `gen-s<seed>-n<i>` so re-running with the same seed
 * against the same clip collides (use another seed or remove the notes first).
 */
export class PatternGenerator implements JobExecutor {
  readonly kind = 'generation' as const;
  readonly id = PATTERN_GENERATOR_ID;

  describe(): ExecutorDescription {
    return {
      name: 'Reference pattern generator (test double, not a composition model)',
      outputs: ['operations', 'midi'],
      deterministic: true,
      parametersSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pitches', 'stepBeats', 'count'],
        properties: {
          pitches: {
            type: 'array',
            minItems: 1,
            maxItems: 128,
            items: { type: 'integer', minimum: 0, maximum: 127 },
          },
          stepBeats: { type: 'number', exclusiveMinimum: 0 },
          count: { type: 'integer', minimum: 1, maximum: 1024 },
          velocity: { type: 'integer', minimum: 1, maximum: 127 },
          clipId: { type: 'string' },
        },
      },
    };
  }

  validate(input: JobInput): Diagnostic[] {
    if (input.kind !== 'generation')
      return [{ code: 'invalid_params', message: 'not a generation job' }];
    const { value, diagnostics } = readParameters(input.params.parameters);
    if (!value) return diagnostics;
    if (!findTargetClip(input.project, value, input.params.target?.trackId)) {
      return [
        {
          code: 'not_found',
          message: 'no target MIDI clip found for the pattern generator',
          path: '/parameters/clipId',
        },
      ];
    }
    return [];
  }

  async run(input: JobInput, ctx: JobContext): Promise<JobOutput> {
    if (input.kind !== 'generation')
      throw new Error('pattern generator only handles generation jobs');
    const { value } = readParameters(input.params.parameters);
    if (!value) throw new Error('invalid pattern parameters');
    const clip = findTargetClip(input.project, value, input.params.target?.trackId);
    if (!clip) throw new Error('no target MIDI clip');
    const seed = input.params.seed ?? 0;
    const rand = mulberry32(seed);
    const notes: Note[] = [];
    for (let i = 0; i < value.count; i++) {
      const pitch = value.pitches[Math.floor(rand() * value.pitches.length)]!;
      const length = Math.round((0.5 + 0.5 * rand()) * 1000) / 1000;
      const velocity = value.velocity ?? 60 + Math.floor(rand() * 40);
      notes.push({
        id: `gen-s${seed}-n${i}`,
        pitch,
        start: i * value.stepBeats,
        duration: value.stepBeats * length,
        velocity,
        channel: 0,
      });
      if (i % 64 === 63) ctx.progress((i + 1) / value.count);
    }
    const operations: Operation[] = [{ op: 'midi.notes.add', clipId: clip.id, notes }];
    return {
      operations,
      reproducibility: {
        seed,
        generator: PATTERN_GENERATOR_ID,
        clipId: clip.id,
        deterministic: true,
      },
    };
  }
}

/** The two reference test doubles, ready to pass as `executors`. */
export const referenceExecutors = (): JobExecutor[] => [
  new ManifestRenderer(),
  new PatternGenerator(),
];
