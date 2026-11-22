/**
 * Normative time conversions (specs/audio/AUDIO-DOMAIN.md §Time).
 *
 * - A beat is a quarter note. A tempo point starts a segment that runs to the next point.
 *   `step` segments have constant tempo. `linear` segments ramp bpm linearly in beats from the
 *   point's `bpm` to the next point's `bpm`. The last segment is always constant.
 * - Constant segment of tempo T: seconds = Δbeats × 60 / T.
 * - Linear segment from (b0, T0) to (b1, T1) with k = (T1 − T0) / (b1 − b0) ≠ 0:
 *   seconds(b) = 60 / k × log1p(k (b − b0) / T0);
 *   beats(s) = b0 + T0 × expm1(k s / 60) / k. A ramp with T1 = T0 is constant.
 *   (These equal 60/k × ln(T(b)/T0) and T0 (exp(ks/60) − 1)/k, written so a nearly flat ramp
 *   keeps full precision.)
 * - Implementations MUST use these formulas (IEEE-754 double, `Math.log1p`/`Math.expm1`) so
 *   independent hosts agree to within floating-point rounding.
 * - samples = round(seconds × sampleRate), rounding half away from zero (Math.round for
 *   non-negative values). Converting samples → seconds is exact division.
 * - Bars are 0-based. A bar lasts `numerator × 4 / denominator` beats under its meter.
 */
import type { MeterPoint, TempoPoint } from './model.js';

interface TempoSegment {
  beat: number;
  /** Segment end beat (Infinity for the last segment). */
  end: number;
  bpm: number;
  /** bpm change per beat; 0 for constant segments. */
  slope: number;
}

type TempoInput = readonly (Omit<TempoPoint, 'curve'> & { curve?: TempoPoint['curve'] })[];

function segments(tempo: TempoInput): TempoSegment[] {
  const t = [...tempo].sort((a, b) => a.beat - b.beat);
  if (t.length === 0 || t[0]!.beat !== 0) throw new RangeError('tempo map must start at beat 0');
  return t.map((p, i) => {
    const next = t[i + 1];
    const end = next ? next.beat : Infinity;
    const slope =
      next && p.curve === 'linear' && next.bpm !== p.bpm && end > p.beat
        ? (next.bpm - p.bpm) / (end - p.beat)
        : 0;
    return { beat: p.beat, end, bpm: p.bpm, slope };
  });
}

/** Seconds elapsed from the segment start to `beats` (beats within the segment). */
function segmentSeconds(s: TempoSegment, beats: number): number {
  const db = beats - s.beat;
  if (s.slope === 0) return (db * 60) / s.bpm;
  return (60 / s.slope) * Math.log1p((s.slope * db) / s.bpm);
}

/** Beats elapsed from the segment start after `seconds` within the segment. */
function segmentBeats(s: TempoSegment, seconds: number): number {
  if (s.slope === 0) return (seconds * s.bpm) / 60;
  return (s.bpm * Math.expm1((s.slope * seconds) / 60)) / s.slope;
}

/** Instantaneous tempo (bpm) at a beat position. */
export function tempoAt(beats: number, tempo: TempoInput): number {
  const segs = segments(tempo);
  const s = segs.find((g) => beats < g.end) ?? segs[segs.length - 1]!;
  return s.bpm + s.slope * (Math.max(beats, s.beat) - s.beat);
}

export function beatsToSeconds(beats: number, tempo: TempoInput): number {
  let seconds = 0;
  for (const s of segments(tempo)) {
    if (beats <= s.end) return seconds + segmentSeconds(s, beats);
    seconds += segmentSeconds(s, s.end);
  }
  return seconds;
}

export function secondsToBeats(seconds: number, tempo: TempoInput): number {
  let acc = 0;
  for (const s of segments(tempo)) {
    const segSeconds = s.end === Infinity ? Infinity : segmentSeconds(s, s.end);
    if (seconds <= acc + segSeconds) return s.beat + segmentBeats(s, seconds - acc);
    acc += segSeconds;
  }
  return Infinity;
}

export function secondsToSamples(seconds: number, sampleRate: number): number {
  const v = seconds * sampleRate;
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

export function samplesToSeconds(samples: number, sampleRate: number): number {
  return samples / sampleRate;
}

function sortedMeter(meter: readonly MeterPoint[]): MeterPoint[] {
  const m = [...meter].sort((a, b) => a.bar - b.bar);
  if (m.length === 0 || m[0]!.bar !== 0) throw new RangeError('meter map must start at bar 0');
  return m;
}

/** Beats per bar under a meter point. */
export const barLengthBeats = (m: MeterPoint): number => (m.numerator * 4) / m.denominator;

/** Beat position of the start of a (possibly fractional) 0-based bar. */
export function barsToBeats(bar: number, meter: readonly MeterPoint[]): number {
  const m = sortedMeter(meter);
  let beats = 0;
  for (let i = 0; i < m.length; i++) {
    const p = m[i]!;
    const nextBar = i + 1 < m.length ? m[i + 1]!.bar : Infinity;
    if (bar <= nextBar) return beats + (bar - p.bar) * barLengthBeats(p);
    beats += (nextBar - p.bar) * barLengthBeats(p);
  }
  return beats;
}

/** Inverse of barsToBeats: fractional 0-based bar index for a beat position. */
export function beatsToBars(beats: number, meter: readonly MeterPoint[]): number {
  const m = sortedMeter(meter);
  let acc = 0;
  for (let i = 0; i < m.length; i++) {
    const p = m[i]!;
    const nextBar = i + 1 < m.length ? m[i + 1]!.bar : Infinity;
    const segBeats = (nextBar - p.bar) * barLengthBeats(p);
    if (beats <= acc + segBeats) return p.bar + (beats - acc) / barLengthBeats(p);
    acc += segBeats;
  }
  return Infinity;
}

/** Convert a position in a given timebase to seconds. */
export function toSeconds(value: number, timebase: 'beats' | 'seconds', tempo: TempoInput): number {
  return timebase === 'seconds' ? value : beatsToSeconds(value, tempo);
}

/** Convert seconds to a position in a given timebase. */
export function fromSeconds(
  seconds: number,
  timebase: 'beats' | 'seconds',
  tempo: TempoInput,
): number {
  return timebase === 'seconds' ? seconds : secondsToBeats(seconds, tempo);
}

/** Convert a value in any TimeUnit to seconds. Samples require a sample rate. */
export function unitToSeconds(
  value: number,
  unit: 'beats' | 'seconds' | 'samples',
  tempo: TempoInput,
  sampleRate?: number,
): number {
  if (unit === 'seconds') return value;
  if (unit === 'beats') return beatsToSeconds(value, tempo);
  if (!sampleRate) throw new RangeError('sample-based positions require a project sampleRate');
  return samplesToSeconds(value, sampleRate);
}
