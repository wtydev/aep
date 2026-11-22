import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { AepError } from './errors.js';

function rejected(message: string): never {
  throw new AepError('path_rejected', message);
}

const isEnoent = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Resolve `relative` inside `root` with no traversal or symlink escape. Rejects absolute
 * paths, drive letters (`C:x`), backslashes, NUL bytes, empty paths, and empty/`.`/`..`
 * segments. The final path's realpath must lie strictly inside realpath(root); a non-existent
 * leaf is resolved against the nearest existing ancestor. Returns the absolute real path.
 */
export async function resolveInsideRoot(root: string, relative: string): Promise<string> {
  if (relative.length === 0) rejected('path is empty');
  if (relative.includes('\0')) rejected('path contains a NUL byte');
  if (relative.includes('\\')) rejected('backslashes are not allowed in paths');
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    rejected(`absolute paths are not allowed: ${JSON.stringify(relative)}`);
  }
  const segments = relative.split('/');
  if (segments.some((s) => s.length === 0 || s === '.' || s === '..')) {
    rejected(`path contains an empty, '.' or '..' segment: ${JSON.stringify(relative)}`);
  }

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (e) {
    if (isEnoent(e)) rejected('import root does not exist');
    throw e;
  }

  const candidate = path.join(realRoot, ...segments);

  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (e) {
    if (!isEnoent(e)) throw e;
    // Leaf (or more) does not exist: realpath the nearest existing ancestor instead.
    const missing: string[] = [];
    let current = candidate;
    let base: string | undefined;
    while (base === undefined) {
      const parent = path.dirname(current);
      if (parent === current) throw e;
      missing.unshift(path.basename(current));
      current = parent;
      try {
        base = await realpath(current);
      } catch (e2) {
        if (!isEnoent(e2)) throw e2;
      }
    }
    resolved = path.join(base, ...missing);
  }

  if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) {
    rejected(`path escapes the import root: ${JSON.stringify(relative)}`);
  }
  return resolved;
}
