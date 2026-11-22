import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Constant-time string comparison (for session credentials). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Opaque session credential: 32 random bytes, base64url-encoded (256 bits ≥ 128 required). */
export function generateCredential(): string {
  return randomBytes(32).toString('base64url');
}

/** `prefix` + '-' + 16 hex chars; the result matches the AEP id charset. */
export function generateId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString('hex')}`;
}
