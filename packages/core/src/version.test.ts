import { describe, expect, it } from 'vitest';
import { isCompatible, negotiateVersion, SUPPORTED_PROTOCOL_VERSIONS } from './version.js';

describe('isCompatible', () => {
  it('treats 0.x minors as incompatible', () => {
    expect(isCompatible('0.1', '0.1')).toBe(true);
    expect(isCompatible('0.1', '0.2')).toBe(false);
    expect(isCompatible('0.2', '0.1')).toBe(false);
  });

  it('treats same-major 1.x+ as compatible', () => {
    expect(isCompatible('1.0', '1.3')).toBe(true);
    expect(isCompatible('1.3', '1.0')).toBe(true);
    expect(isCompatible('1.9', '2.0')).toBe(false);
    expect(isCompatible('0.9', '1.0')).toBe(false);
  });

  it('rejects malformed versions', () => {
    expect(isCompatible('1', '1.0')).toBe(false);
    expect(isCompatible('1.0.0', '1.0')).toBe(false);
    expect(isCompatible('x.y', '1.0')).toBe(false);
  });
});

describe('negotiateVersion', () => {
  it('returns null when no pair is compatible', () => {
    expect(negotiateVersion(['0.1'], ['0.2'])).toBeNull();
    expect(negotiateVersion([], ['0.1'])).toBeNull();
    expect(negotiateVersion(['0.1'], [])).toBeNull();
  });

  it('picks the lower version of a compatible pair', () => {
    expect(negotiateVersion(['1.0'], ['1.3'])).toBe('1.0');
    expect(negotiateVersion(['1.3'], ['1.0'])).toBe('1.0');
  });

  it('picks the highest mutually compatible version', () => {
    expect(negotiateVersion(['0.1', '1.2'], ['1.3'])).toBe('1.2');
    expect(negotiateVersion(['1.0', '1.2'], ['1.2', '2.0'])).toBe('1.2');
  });

  it('supports the declared protocol versions', () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(['0.1']);
    expect(negotiateVersion(SUPPORTED_PROTOCOL_VERSIONS, ['0.1'])).toBe('0.1');
  });
});
