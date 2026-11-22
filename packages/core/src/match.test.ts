import { describe, expect, it } from 'vitest';
import { matchesOperationPattern } from './match.js';

describe('matchesOperationPattern', () => {
  it('matches * against everything', () => {
    expect(matchesOperationPattern('clip.trim', '*')).toBe(true);
    expect(matchesOperationPattern('anything', '*')).toBe(true);
  });

  it('matches namespace wildcards', () => {
    expect(matchesOperationPattern('midi.notes.add', 'midi.notes.*')).toBe(true);
    expect(matchesOperationPattern('midi.notes.remove', 'midi.notes.*')).toBe(true);
    expect(matchesOperationPattern('midi.events.update', 'midi.notes.*')).toBe(false);
    expect(matchesOperationPattern('midi.notes', 'midi.notes.*')).toBe(false);
    expect(matchesOperationPattern('midi.notesx.add', 'midi.notes.*')).toBe(false);
  });

  it('matches exact names only', () => {
    expect(matchesOperationPattern('clip.trim', 'clip.trim')).toBe(true);
    expect(matchesOperationPattern('clip.split', 'clip.trim')).toBe(false);
  });
});
