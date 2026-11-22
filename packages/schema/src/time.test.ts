import { describe, expect, it } from 'vitest';
import type { TempoPoint } from './model.js';
import { beatsToSeconds, secondsToBeats, tempoAt } from './time.js';

/** 60 → 120 bpm, linear over 4 beats (slope 15 bpm/beat), then constant 120. */
const RAMP: TempoPoint[] = [
  { beat: 0, bpm: 60, curve: 'linear' },
  { beat: 4, bpm: 120, curve: 'step' },
];

const STEP_120: TempoPoint[] = [{ beat: 0, bpm: 120, curve: 'step' }];

const near = (a: number, b: number): void => {
  expect(Math.abs(a - b)).toBeLessThan(1e-9);
};

describe('linear tempo ramps', () => {
  it('integrates the ramp logarithmically', () => {
    // k = 15 bpm/beat: seconds(b) = 60/15 * ln(T(b)/60) with T(b) = 60 + 15b.
    near(beatsToSeconds(4, RAMP), 4 * Math.LN2);
    near(beatsToSeconds(2, RAMP), 4 * Math.log(1.5));
    // Past the ramp the last segment is constant 120 bpm: +4 beats = +2 s.
    near(beatsToSeconds(8, RAMP), 4 * Math.LN2 + 2);
  });

  it('keeps precision on a nearly flat ramp', () => {
    const flat: TempoPoint[] = [
      { beat: 0, bpm: 120, curve: 'linear' },
      { beat: 8, bpm: 120.00000000000001, curve: 'step' },
    ];
    near(beatsToSeconds(4, flat), 2);
    near(beatsToSeconds(8, flat), 4);
    near(secondsToBeats(2, flat), 4);
  });

  it('ramps symmetrically downward', () => {
    const down: TempoPoint[] = [
      { beat: 0, bpm: 120, curve: 'linear' },
      { beat: 4, bpm: 60, curve: 'step' },
    ];
    near(beatsToSeconds(4, down), 4 * Math.LN2);
    near(tempoAt(2, down), 90);
  });

  it('round-trips beats and seconds across the ramp and the constant tail', () => {
    for (const b of [0.25, 1.5, 2.7, 3.9, 4, 5.5, 8]) {
      near(secondsToBeats(beatsToSeconds(b, RAMP), RAMP), b);
    }
    for (const s of [0.3, 1.7, 2.7, 4.4]) {
      near(beatsToSeconds(secondsToBeats(s, RAMP), RAMP), s);
    }
  });

  it('treats a linear segment between equal bpms as constant', () => {
    const flat: TempoPoint[] = [
      { beat: 0, bpm: 100, curve: 'linear' },
      { beat: 4, bpm: 100, curve: 'step' },
    ];
    const stepped: TempoPoint[] = [
      { beat: 0, bpm: 100, curve: 'step' },
      { beat: 4, bpm: 100, curve: 'step' },
    ];
    for (const b of [1, 2, 4, 6]) {
      near(beatsToSeconds(b, flat), beatsToSeconds(b, stepped));
      near(tempoAt(b, flat), 100);
    }
  });

  it('ignores the curve of the last point', () => {
    const single: TempoPoint[] = [{ beat: 0, bpm: 120, curve: 'linear' }];
    near(beatsToSeconds(4, single), 2);
    near(tempoAt(4, single), 120);
    const linearTail: TempoPoint[] = [
      { beat: 0, bpm: 60, curve: 'linear' },
      { beat: 4, bpm: 120, curve: 'linear' },
    ];
    near(beatsToSeconds(8, linearTail), 4 * Math.LN2 + 2);
  });
});

describe('tempoAt', () => {
  it('reports instantaneous bpm inside a ramp and constant segments', () => {
    near(tempoAt(0, RAMP), 60);
    near(tempoAt(2, RAMP), 90);
    near(tempoAt(4, RAMP), 120);
    near(tempoAt(10, RAMP), 120);
  });

  it('is constant for step curves', () => {
    near(tempoAt(0, STEP_120), 120);
    near(tempoAt(100, STEP_120), 120);
  });
});
