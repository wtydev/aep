import { describe, expect, it } from 'vitest';
import type { Change } from '@aep/schema';
import { AepError } from './errors.js';
import {
  applyChanges,
  deepEqual,
  diffEntities,
  invertChanges,
  type EntityMap,
  type EntityRecord,
} from './entities.js';

const map = (entries: Record<string, EntityRecord>): EntityMap => new Map(Object.entries(entries));

const beforeMap = (): EntityMap =>
  map({
    '/project': { entity: 'project', value: { id: 'p', name: 'a' } },
    '/tempo': { entity: 'tempo', value: [{ beat: 0, bpm: 120 }] },
    '/tracks/t1': { entity: 'track', value: { id: 't1', name: 'x' } },
    '/tracks/t1/clips/c1': { entity: 'clip', value: { id: 'c1', start: 0 } },
    '/tracks/t1/clips/c1/notes/n1': { entity: 'note', value: { id: 'n1', pitch: 60 } },
    '/tracks/t2': { entity: 'track', value: { id: 't2', name: 'y', gainDb: 0 } },
  });

const afterMap = (): EntityMap =>
  map({
    '/project': { entity: 'project', value: { id: 'p', name: 'a' } },
    '/tempo': { entity: 'tempo', value: [{ beat: 0, bpm: 90 }] },
    '/tracks/t1': { entity: 'track', value: { id: 't1', name: 'x' } },
    '/tracks/t2': { entity: 'track', value: { id: 't2', name: 'y', gainDb: -3 } },
    '/tracks/t3': { entity: 'track', value: { id: 't3', name: 'z' } },
    '/tracks/t3/clips/c9': { entity: 'clip', value: { id: 'c9', start: 8 } },
  });

const expectMapsEqual = (a: EntityMap, b: EntityMap): void => {
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  for (const [path, rec] of a) {
    expect(rec.entity).toBe(b.get(path)!.entity);
    expect(deepEqual(rec.value, b.get(path)!.value)).toBe(true);
  }
};

describe('deepEqual', () => {
  it('compares structurally and ignores undefined-valued keys', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(deepEqual({ a: undefined, b: 1 }, { b: 1 })).toBe(true);
    expect(deepEqual([1, 2], [1, 3])).toBe(false);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual('x', 'x')).toBe(true);
    expect(deepEqual(null, undefined)).toBe(false);
  });
});

describe('diffEntities', () => {
  it('orders removes deepest-first, adds shallowest-first, then updates by path', () => {
    const changes = diffEntities(beforeMap(), afterMap());
    expect(changes.map((c) => `${c.kind}:${c.path}`)).toEqual([
      'remove:/tracks/t1/clips/c1/notes/n1',
      'remove:/tracks/t1/clips/c1',
      'add:/tracks/t3',
      'add:/tracks/t3/clips/c9',
      'update:/tempo',
      'update:/tracks/t2',
    ]);
  });

  it('records before/after values and sorted changed fields', () => {
    const changes = diffEntities(beforeMap(), afterMap());
    const update = changes.find((c) => c.path === '/tracks/t2')!;
    expect(update.fields).toEqual(['gainDb']);
    expect(update.before).toEqual({ id: 't2', name: 'y', gainDb: 0 });
    expect(update.after).toEqual({ id: 't2', name: 'y', gainDb: -3 });
    const removed = changes.find((c) => c.path === '/tracks/t1/clips/c1')!;
    expect(removed.kind).toBe('remove');
    expect(removed.before).toEqual({ id: 'c1', start: 0 });
    const added = changes.find((c) => c.path === '/tracks/t3')!;
    expect(added.kind).toBe('add');
    expect(added.after).toEqual({ id: 't3', name: 'z' });
  });

  it('leaves fields undefined for non-object (array) values', () => {
    const tempoChange = diffEntities(beforeMap(), afterMap()).find((c) => c.path === '/tempo')!;
    expect(tempoChange.fields).toBeUndefined();
  });

  it('emits nothing for identical maps', () => {
    expect(diffEntities(beforeMap(), beforeMap())).toEqual([]);
  });
});

describe('invertChanges + applyChanges', () => {
  it('round-trips before → after → before', () => {
    const before = beforeMap();
    const after = afterMap();
    const changes = diffEntities(before, after);
    expectMapsEqual(applyChanges(before, changes), after);
    expectMapsEqual(applyChanges(after, invertChanges(changes)), before);
  });

  it('does not mutate the input map and returns a fresh one', () => {
    const before = beforeMap();
    const changes = diffEntities(before, afterMap());
    const sizeBefore = before.size;
    const applied = applyChanges(before, changes);
    expect(before.size).toBe(sizeBefore);
    expect(applied).not.toBe(before);
  });
});

describe('applyChanges conflicts', () => {
  const expectConflict = (m: EntityMap, changes: Change[]): void => {
    try {
      applyChanges(m, changes);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AepError);
      expect((e as AepError).code).toBe('undo_conflict');
    }
  };

  it('rejects an update whose before value does not match', () => {
    expectConflict(beforeMap(), [
      {
        path: '/tracks/t2',
        entity: 'track',
        kind: 'update',
        before: { id: 't2', name: 'y', gainDb: 6 },
        after: { id: 't2', name: 'y', gainDb: 0 },
      },
    ]);
  });

  it('rejects a remove whose current value differs', () => {
    expectConflict(beforeMap(), [
      { path: '/tracks/t2', entity: 'track', kind: 'remove', before: { id: 'other' } },
    ]);
  });

  it('rejects a remove of a missing entity', () => {
    expectConflict(beforeMap(), [
      { path: '/tracks/zzz', entity: 'track', kind: 'remove', before: {} },
    ]);
  });

  it('rejects an add over an existing path', () => {
    expectConflict(beforeMap(), [
      { path: '/tracks/t1', entity: 'track', kind: 'add', after: { id: 't1' } },
    ]);
  });
});
