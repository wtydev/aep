import { describe, expect, it } from 'vitest';
import type { CoreRequest } from '@aep/schema';
import { canonicalJson, requestFingerprint, sha256Hex } from './canonical.js';

const request = (overrides: Partial<CoreRequest> = {}): CoreRequest => ({
  protocol: 'mep/core/1',
  session: 'sess1',
  workspace: 'ws1',
  id: 'req1',
  credential: 'secret-a',
  action: 'transaction.commit',
  version: 1,
  params: { transaction: { operations: [{ op: 'project.update', patch: { name: 'x' } }] } },
  ...overrides,
});

describe('canonicalJson', () => {
  it('sorts object keys recursively with no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });

  it('drops undefined properties', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('is deterministic regardless of key insertion order', () => {
    expect(canonicalJson({ z: 1, m: 2, a: 3 })).toBe(canonicalJson({ a: 3, m: 2, z: 1 }));
  });
});

describe('sha256Hex', () => {
  it('hashes strings and bytes', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex(new Uint8Array([0x61, 0x62, 0x63]))).toBe(sha256Hex('abc'));
  });
});

describe('requestFingerprint', () => {
  it('ignores the credential', () => {
    expect(requestFingerprint(request())).toBe(
      requestFingerprint(request({ credential: 'other' })),
    );
  });

  it('changes with any other field', () => {
    const base = requestFingerprint(request());
    expect(requestFingerprint(request({ id: 'req2' }))).not.toBe(base);
    expect(requestFingerprint(request({ params: {} }))).not.toBe(base);
    expect(requestFingerprint(request({ baseRevision: 'rev-1' }))).not.toBe(base);
  });
});
