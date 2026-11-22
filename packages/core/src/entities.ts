import type { Change, EntityKind } from '@wty.dev/aep-schema';
import { AepError } from './errors.js';

/**
 * One flattened entity. `value` is a JSON value without child collections (children are
 * separate entities at deeper paths).
 */
export interface EntityRecord {
  entity: EntityKind;
  value: unknown;
}

/** Entity path (e.g. `/tracks/t1/clips/c1`) → record. */
export type EntityMap = Map<string, EntityRecord>;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const definedKeys = (o: Record<string, unknown>): string[] =>
  Object.keys(o).filter((k) => o[k] !== undefined);

/** Structural equality over JSON values. Object keys with `undefined` values are ignored. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = definedKeys(a);
    const kb = definedKeys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

const depth = (path: string): number => path.split('/').length - 1;

/** Sorted top-level field names whose values differ; undefined for non-object values. */
function diffFields(before: unknown, after: unknown): string[] | undefined {
  if (!isObject(before) || !isObject(after)) return undefined;
  const keys = new Set([...definedKeys(before), ...definedKeys(after)]);
  return [...keys].filter((k) => !deepEqual(before[k], after[k])).sort();
}

/**
 * Entity-map diff. Deterministic order: removes (deepest path first, then lexicographic),
 * then adds (shallowest first, then lexicographic), then updates (lexicographic by path).
 * Updates carry `fields` = sorted top-level keys whose values differ (object values only).
 */
export function diffEntities(before: EntityMap, after: EntityMap): Change[] {
  const removes: Change[] = [];
  const adds: Change[] = [];
  const updates: Change[] = [];
  for (const [path, rec] of before) {
    if (!after.has(path))
      removes.push({ path, entity: rec.entity, kind: 'remove', before: rec.value });
  }
  for (const [path, rec] of after) {
    const old = before.get(path);
    if (!old) {
      adds.push({ path, entity: rec.entity, kind: 'add', after: rec.value });
      continue;
    }
    if (old.entity !== rec.entity || !deepEqual(old.value, rec.value)) {
      const change: Change = {
        path,
        entity: rec.entity,
        kind: 'update',
        before: old.value,
        after: rec.value,
      };
      const fields = diffFields(old.value, rec.value);
      if (fields !== undefined) change.fields = fields;
      updates.push(change);
    }
  }
  removes.sort((a, b) => depth(b.path) - depth(a.path) || a.path.localeCompare(b.path));
  adds.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
  updates.sort((a, b) => a.path.localeCompare(b.path));
  return [...removes, ...adds, ...updates];
}

/** Inverse of a change list: reversed order, add↔remove swapped, before/after swapped. */
export function invertChanges(changes: Change[]): Change[] {
  return [...changes].reverse().map((c) => {
    if (c.kind === 'add') {
      return { path: c.path, entity: c.entity, kind: 'remove', before: c.after } as Change;
    }
    if (c.kind === 'remove') {
      return { path: c.path, entity: c.entity, kind: 'add', after: c.before } as Change;
    }
    return {
      path: c.path,
      entity: c.entity,
      kind: 'update',
      before: c.after,
      after: c.before,
      fields: c.fields,
    } as Change;
  });
}

/**
 * Apply a change list to an entity map, returning a NEW map (input is not mutated). Throws
 * `AepError('undo_conflict')` when a change does not match the current state: an `add` whose
 * path already exists, or a `remove`/`update` whose current value is not deep-equal to
 * `change.before`.
 */
export function applyChanges(map: EntityMap, changes: Change[]): EntityMap {
  const next: EntityMap = new Map(map);
  for (const change of changes) {
    const current = next.get(change.path);
    if (change.kind === 'add') {
      if (current) {
        throw new AepError('undo_conflict', `cannot add ${change.path}: entity already exists`);
      }
      next.set(change.path, { entity: change.entity, value: structuredClone(change.after) });
      continue;
    }
    if (!current || current.entity !== change.entity || !deepEqual(current.value, change.before)) {
      throw new AepError(
        'undo_conflict',
        `cannot ${change.kind} ${change.path}: current value does not match the change`,
      );
    }
    if (change.kind === 'remove') {
      next.delete(change.path);
    } else {
      next.set(change.path, { entity: change.entity, value: structuredClone(change.after) });
    }
  }
  return next;
}
