/**
 * Normative time conversions (specs/audio/AUDIO-DOMAIN.md §Time).
 *
 * - A beat is a quarter note. Tempo points are step changes: tempo is constant from a point's
 *   `beat` until the next point.
 * - seconds ↔ beats is exact in IEEE-754 double arithmetic as specified here; implementations
 *   MUST use these formulas so independent hosts agree.
 * - samples = round(seconds × sampleRate), rounding half away from zero (Math.round for
 *   non-negative values). Converting samples → seconds is exact division.
 * - Bars are 0-based. A bar lasts `numerator × 4 / denominator` beats under its meter.
 */
import type { MeterPoint, TempoPoint } from './model.js';

function sortedTempo(tempo: readonly TempoPoint[]): TempoPoint[] {
  const t = [...tempo].sort((a, b) => a.beat - b.beat);
  if (t.length === 0 || t[0]!.beat !== 0) throw new RangeError('tempo map must start at beat 0');
  return t;
}

export function beatsToSeconds(beats: number, tempo: readonly TempoPoint[]): number {
  const t = sortedTempo(tempo);
  let seconds = 0;
  for (let i = 0; i < t.length; i++) {
    const p = t[i]!;
    const segEnd = i + 1 < t.length ? t[i + 1]!.beat : Infinity;
    if (beats <= segEnd) return seconds + ((beats - p.beat) * 60) / p.bpm;
    seconds += ((segEnd - p.beat) * 60) / p.bpm;
  }
  return seconds;
}

export function secondsToBeats(seconds: number, tempo: readonly TempoPoint[]): number {
  const t = sortedTempo(tempo);
  let acc = 0;
  for (let i = 0; i < t.length; i++) {
    const p = t[i]!;
    const segEnd = i + 1 < t.length ? t[i + 1]!.beat : Infinity;
    const segSeconds = ((segEnd - p.beat) * 60) / p.bpm;
    if (seconds <= acc + segSeconds) return p.beat + ((seconds - acc) * p.bpm) / 60;
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
export function toSeconds(
  value: number,
  timebase: 'beats' | 'seconds',
  tempo: readonly TempoPoint[],
): number {
  return timebase === 'seconds' ? value : beatsToSeconds(value, tempo);
}

/** Convert seconds to a position in a given timebase. */
export function fromSeconds(
  seconds: number,
  timebase: 'beats' | 'seconds',
  tempo: readonly TempoPoint[],
): number {
  return timebase === 'seconds' ? seconds : secondsToBeats(seconds, tempo);
}

/** Convert a value in any TimeUnit to seconds. Samples require a sample rate. */
export function unitToSeconds(
  value: number,
  unit: 'beats' | 'seconds' | 'samples',
  tempo: readonly TempoPoint[],
  sampleRate?: number,
): number {
  if (unit === 'seconds') return value;
  if (unit === 'beats') return beatsToSeconds(value, tempo);
  if (!sampleRate) throw new RangeError('sample-based positions require a project sampleRate');
  return samplesToSeconds(value, sampleRate);
}
