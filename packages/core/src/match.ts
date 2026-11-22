/**
 * Operation-name pattern match used by scopes. `*` matches everything, `prefix.*` matches any
 * operation in that namespace, anything else is an exact match.
 */
export function matchesOperationPattern(op: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return op.startsWith(pattern.slice(0, -1));
  return op === pattern;
}
