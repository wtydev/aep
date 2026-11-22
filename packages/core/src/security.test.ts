import { describe, expect, it } from 'vitest';
import { constantTimeEqual, generateCredential, generateId } from './security.js';

describe('constantTimeEqual', () => {
  it('compares strings byte-exactly', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
  });
});

describe('generateCredential', () => {
  it('produces distinct base64url secrets', () => {
    const a = generateCredential();
    const b = generateCredential();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('generateId', () => {
  it('produces prefixed 16-hex-char ids in the AEP id charset', () => {
    expect(generateId('req')).toMatch(/^req-[0-9a-f]{16}$/);
    expect(generateId('s')).toMatch(/^[A-Za-z0-9_-]{1,100}$/);
  });
});
