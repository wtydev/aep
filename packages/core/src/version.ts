import { PROTOCOL_VERSION } from '@aep/schema';

export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [PROTOCOL_VERSION];

interface Semver {
  major: number;
  minor: number;
}

function parse(version: string): Semver | null {
  const m = /^(\d+)\.(\d+)$/.exec(version);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

const cmp = (a: Semver, b: Semver): number => a.major - b.major || a.minor - b.minor;

/**
 * Two versions are compatible when they share a major version; before 1.0 they must also
 * share a minor version (0.x minors are not mutually compatible).
 */
export function isCompatible(a: string, b: string): boolean {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb || pa.major !== pb.major) return false;
  return pa.major === 0 ? pa.minor === pb.minor : true;
}

/**
 * Highest version both sides can speak. The negotiated version for a compatible pair is the
 * lower of the two (a 1.0 client and a 1.3 host converse at 1.0). `null` when no pair is
 * compatible.
 */
export function negotiateVersion(
  client: readonly string[],
  host: readonly string[],
): string | null {
  let best: (Semver & { v: string }) | null = null;
  for (const c of client) {
    const pc = parse(c);
    if (!pc) continue;
    for (const h of host) {
      const ph = parse(h);
      if (!ph || !isCompatible(c, h)) continue;
      const lo = cmp(pc, ph) <= 0 ? { ...pc, v: c } : { ...ph, v: h };
      if (!best || cmp(lo, best) > 0) best = lo;
    }
  }
  return best?.v ?? null;
}
