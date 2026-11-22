import { createHash } from 'node:crypto';
import type { CoreRequest } from '@wty.dev/aep-schema';

function serialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? 'null' : serialize(v))).join(',')}]`;
      }
      const rec = value as Record<string, unknown>;
      const keys = Object.keys(rec)
        .filter((k) => rec[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(rec[k])}`).join(',')}}`;
    }
    default:
      return 'null';
  }
}

/**
 * RFC 8785-style canonical JSON: object keys sorted recursively (UTF-16 code unit order, the
 * JavaScript default), no whitespace, `undefined` object properties dropped.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Idempotency fingerprint: sha256 of the canonical request without `credential`. */
export function requestFingerprint(req: CoreRequest): string {
  const { credential: _credential, ...rest } = req;
  return sha256Hex(canonicalJson(rest));
}
