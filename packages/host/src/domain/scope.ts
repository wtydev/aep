import { canonicalJson, deepEqual, matchesOperationPattern } from '@wty.dev/aep-core';
import { toSeconds, unitToSeconds } from '@wty.dev/aep-schema';
import type {
  Change,
  Diagnostic,
  EntityKind,
  MidiClip,
  Operation,
  Project,
  Scope,
} from '@wty.dev/aep-schema';

/** Everything needed to validate a scope against the actual diff (design §5). */
export interface ScopeCheckInput {
  changes: Change[];
  operations: Operation[];
  scope: Scope;
  before: Project;
  after: Project;
}

interface Extent {
  start: number;
  end: number;
}

const EPS = 1e-9;

/** Collection/property name an entity kind checks against `scope.properties`. */
const COLLECTION_NAME: Record<EntityKind, string> = {
  project: 'project',
  tempo: 'tempo',
  meter: 'meter',
  trackOrder: 'trackOrder',
  track: 'tracks',
  instrument: 'instrument',
  effectOrder: 'effectOrder',
  effect: 'effects',
  clip: 'clips',
  note: 'notes',
  midiEvents: 'midiEvents',
  automationLane: 'automation',
  section: 'sections',
  asset: 'assets',
};

const TIME_BEARING: ReadonlySet<EntityKind> = new Set([
  'clip',
  'note',
  'midiEvents',
  'automationLane',
  'section',
]);

interface TimedValue {
  start: number;
  duration: number;
  timebase: 'beats' | 'seconds';
}

const timedExtent = (value: unknown, project: Project): Extent | null => {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as TimedValue;
  return {
    start: toSeconds(v.start, v.timebase, project.tempo),
    end: toSeconds(v.start + v.duration, v.timebase, project.tempo),
  };
};

const clipAtPath = (project: Project, path: string): MidiClip | undefined => {
  const m = /^\/tracks\/([^/]+)\/clips\/([^/]+)/.exec(path);
  if (!m) return undefined;
  const clip = project.tracks.find((t) => t.id === m[1])?.clips.find((c) => c.id === m[2]);
  return clip?.type === 'midi' ? clip : undefined;
};

/** Timeline extent of a note living inside a MIDI clip (source coords mapped through the clip). */
const noteExtent = (note: unknown, clip: MidiClip, project: Project): Extent | null => {
  if (typeof note !== 'object' || note === null) return null;
  const n = note as { start: number; duration: number };
  const start = clip.start + (n.start - clip.offset);
  return {
    start: toSeconds(start, clip.timebase, project.tempo),
    end: toSeconds(start + n.duration, clip.timebase, project.tempo),
  };
};

/** Timeline extent of source-coordinate event times inside a MIDI clip. */
const sourceTimesExtent = (times: number[], clip: MidiClip, project: Project): Extent => {
  const start = clip.start + (Math.min(...times) - clip.offset);
  const end = clip.start + (Math.max(...times) - clip.offset);
  return {
    start: toSeconds(start, clip.timebase, project.tempo),
    end: toSeconds(end, clip.timebase, project.tempo),
  };
};

/** Clip fields that change where the clip's source content lands on the timeline. */
const CLIP_PLACEMENT: ReadonlySet<string> = new Set(['start', 'offset', 'timebase']);

/** Timeline extents of every note and MIDI event of `clip` (none for audio clips). */
function contentExtents(
  side: 'before' | 'after',
  clip: MidiClip | undefined,
  project: Project,
): { side: 'before' | 'after'; extent: Extent }[] {
  if (!clip) return [];
  const out: { side: 'before' | 'after'; extent: Extent }[] = [];
  for (const note of clip.notes) {
    const extent = noteExtent(note, clip, project);
    if (extent) out.push({ side, extent });
  }
  const times = eventTimes(clip).map((e) => e.time);
  if (times.length > 0) out.push({ side, extent: sourceTimesExtent(times, clip, project) });
  return out;
}

interface MidiEventsValue {
  controllers?: { time: number }[];
  pitchBends?: { time: number }[];
}

const eventTimes = (v: MidiEventsValue | undefined): { time: number }[] => [
  ...(v?.controllers ?? []),
  ...(v?.pitchBends ?? []),
];

/** Elements of `a`/`b` not paired by identical canonical content. */
function multisetDiff<T>(a: T[], b: T[]): { onlyA: T[]; onlyB: T[] } {
  const remaining = new Map<string, number>();
  for (const v of b) {
    const k = canonicalJson(v);
    remaining.set(k, (remaining.get(k) ?? 0) + 1);
  }
  const onlyA: T[] = [];
  for (const v of a) {
    const k = canonicalJson(v);
    const n = remaining.get(k) ?? 0;
    if (n > 0) remaining.set(k, n - 1);
    else onlyA.push(v);
  }
  const onlyB: T[] = [];
  for (const v of b) {
    const k = canonicalJson(v);
    const n = remaining.get(k) ?? 0;
    if (n > 0) remaining.set(k, n - 1);
    else onlyB.push(v);
  }
  return { onlyA, onlyB };
}

interface LaneValue {
  timebase: 'beats' | 'seconds';
  points?: { time: number }[];
}

const laneTimesExtent = (times: number[], lane: LaneValue, project: Project): Extent => ({
  start: toSeconds(Math.min(...times), lane.timebase, project.tempo),
  end: toSeconds(Math.max(...times), lane.timebase, project.tempo),
});

/** Point times changed between two automation-lane values, keyed by `time`. */
function changedLaneTimes(
  beforePoints: { time: number }[] | undefined,
  afterPoints: { time: number }[] | undefined,
): { beforeTimes: number[]; afterTimes: number[] } {
  const bp = beforePoints ?? [];
  const ap = afterPoints ?? [];
  const bMap = new Map(bp.map((p) => [p.time, p] as const));
  const aMap = new Map(ap.map((p) => [p.time, p] as const));
  return {
    beforeTimes: bp
      .filter((p) => !aMap.has(p.time) || !deepEqual(p, aMap.get(p.time)))
      .map((p) => p.time),
    afterTimes: ap
      .filter((p) => !bMap.has(p.time) || !deepEqual(p, bMap.get(p.time)))
      .map((p) => p.time),
  };
}

/**
 * Seconds extents a change occupies on each side (`before`/`after` state), or `null` when the
 * entity is not time-bearing or carries no time-bearing content.
 */
function timeExtents(
  change: Change,
  before: Project,
  after: Project,
): { side: 'before' | 'after'; extent: Extent }[] | null {
  const out: { side: 'before' | 'after'; extent: Extent }[] = [];
  switch (change.entity) {
    case 'clip':
    case 'section': {
      const b = change.before !== undefined ? timedExtent(change.before, before) : null;
      const a = change.after !== undefined ? timedExtent(change.after, after) : null;
      if (b) out.push({ side: 'before', extent: b });
      if (a) out.push({ side: 'after', extent: a });
      // Re-placing a MIDI clip moves its notes and events on the timeline even though they
      // are not in the diff, so their mapped extents count as part of the change.
      if (change.entity === 'clip' && change.fields?.some((f) => CLIP_PLACEMENT.has(f))) {
        out.push(...contentExtents('before', clipAtPath(before, change.path), before));
        out.push(...contentExtents('after', clipAtPath(after, change.path), after));
      }
      return out;
    }
    case 'note': {
      if (change.before !== undefined) {
        const clip = clipAtPath(before, change.path);
        const e = clip ? noteExtent(change.before, clip, before) : null;
        if (e) out.push({ side: 'before', extent: e });
      }
      if (change.after !== undefined) {
        const clip = clipAtPath(after, change.path);
        const e = clip ? noteExtent(change.after, clip, after) : null;
        if (e) out.push({ side: 'after', extent: e });
      }
      return out;
    }
    case 'midiEvents': {
      const b = change.before as MidiEventsValue | undefined;
      const a = change.after as MidiEventsValue | undefined;
      let beforeTimes: number[] = [];
      let afterTimes: number[] = [];
      if (change.kind === 'add') afterTimes = eventTimes(a).map((e) => e.time);
      else if (change.kind === 'remove') beforeTimes = eventTimes(b).map((e) => e.time);
      else {
        const diff = multisetDiff(eventTimes(b), eventTimes(a));
        beforeTimes = diff.onlyA.map((e) => e.time);
        afterTimes = diff.onlyB.map((e) => e.time);
      }
      if (beforeTimes.length > 0) {
        const clip = clipAtPath(before, change.path);
        if (clip)
          out.push({ side: 'before', extent: sourceTimesExtent(beforeTimes, clip, before) });
      }
      if (afterTimes.length > 0) {
        const clip = clipAtPath(after, change.path);
        if (clip) out.push({ side: 'after', extent: sourceTimesExtent(afterTimes, clip, after) });
      }
      return out;
    }
    case 'automationLane': {
      const b = change.before as LaneValue | undefined;
      const a = change.after as LaneValue | undefined;
      let beforeTimes: number[] = [];
      let afterTimes: number[] = [];
      if (change.kind === 'add') afterTimes = (a?.points ?? []).map((p) => p.time);
      else if (change.kind === 'remove') beforeTimes = (b?.points ?? []).map((p) => p.time);
      else ({ beforeTimes, afterTimes } = changedLaneTimes(b?.points, a?.points));
      if (beforeTimes.length > 0 && b) {
        out.push({ side: 'before', extent: laneTimesExtent(beforeTimes, b, before) });
      }
      if (afterTimes.length > 0 && a) {
        out.push({ side: 'after', extent: laneTimesExtent(afterTimes, a, after) });
      }
      return out;
    }
    default:
      return null;
  }
}

/**
 * Validate a scope against the actual state diff (design §5). Returns one `scope_violation`
 * diagnostic per offending change (`path` = entity path), plus one per disallowed operation.
 */
export function checkScope(input: ScopeCheckInput): Diagnostic[] {
  const { changes, operations, scope, before, after } = input;
  const diagnostics: Diagnostic[] = [];

  if (scope.operations) {
    operations.forEach((op, i) => {
      if (!scope.operations!.some((p) => matchesOperationPattern(op.op, p))) {
        diagnostics.push({
          code: 'scope_violation',
          message: `operation '${op.op}' is not permitted by scope.operations`,
          operationIndex: i,
        });
      }
    });
  }

  let rangeBefore: Extent | undefined;
  let rangeAfter: Extent | undefined;
  if (scope.timeRange) {
    try {
      rangeBefore = {
        start: unitToSeconds(
          scope.timeRange.start,
          scope.timeRange.unit,
          before.tempo,
          before.sampleRate,
        ),
        end: unitToSeconds(
          scope.timeRange.end,
          scope.timeRange.unit,
          before.tempo,
          before.sampleRate,
        ),
      };
      rangeAfter = {
        start: unitToSeconds(
          scope.timeRange.start,
          scope.timeRange.unit,
          after.tempo,
          after.sampleRate,
        ),
        end: unitToSeconds(
          scope.timeRange.end,
          scope.timeRange.unit,
          after.tempo,
          after.sampleRate,
        ),
      };
    } catch {
      diagnostics.push({
        code: 'scope_violation',
        message:
          'scope.timeRange cannot be converted to seconds (samples require a project sampleRate)',
      });
    }
  }

  for (const change of changes) {
    const reasons: string[] = [];

    if (scope.tracks) {
      const m = /^\/tracks\/([^/]+)/.exec(change.path);
      if (!m || !scope.tracks.includes(m[1]!)) {
        reasons.push(`change is outside the permitted tracks (${change.path})`);
      }
    }

    if (scope.clips) {
      const m = /^\/tracks\/[^/]+\/clips\/([^/]+)(?:\/|$)/.exec(change.path);
      if (!m || !scope.clips.includes(m[1]!)) {
        reasons.push(`change is outside the permitted clips (${change.path})`);
      }
    }

    if (scope.timeRange && rangeBefore && rangeAfter) {
      if (!TIME_BEARING.has(change.entity)) {
        reasons.push(`change to '${change.entity}' is not time-bearing`);
      } else {
        const extents = timeExtents(change, before, after);
        if (extents === null || extents.length === 0) {
          reasons.push(`change to '${change.entity}' carries no time-bearing extent`);
        } else {
          for (const { side, extent } of extents) {
            const range = side === 'before' ? rangeBefore : rangeAfter;
            if (extent.start < range.start - EPS || extent.end > range.end + EPS) {
              reasons.push(
                `${side} extent [${extent.start}, ${extent.end}]s lies outside ` +
                  `scope.timeRange [${range.start}, ${range.end}]s`,
              );
            }
          }
        }
      }
    }

    if (scope.properties) {
      if (change.kind === 'update') {
        const names = change.fields ?? [COLLECTION_NAME[change.entity]];
        const denied = names.filter((n) => !scope.properties!.includes(n));
        if (denied.length > 0) {
          reasons.push(`properties not permitted by scope.properties: ${denied.join(', ')}`);
        }
      } else {
        const name = COLLECTION_NAME[change.entity];
        if (!scope.properties.includes(name)) {
          reasons.push(`collection '${name}' is not permitted by scope.properties`);
        }
      }
    }

    if (reasons.length > 0) {
      diagnostics.push({ code: 'scope_violation', message: reasons.join('; '), path: change.path });
    }
  }

  return diagnostics;
}
