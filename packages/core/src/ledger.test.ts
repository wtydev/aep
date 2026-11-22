import { describe, expect, it } from 'vitest';
import type { CoreResult } from '@wty.dev/aep-schema';
import { RequestLedger } from './ledger.js';

const result = (id: string): CoreResult => ({
  protocol: 'aep/1',
  session: 's1',
  workspace: 'w1',
  id,
  status: 'succeeded',
  revision: 'rev-1',
  output: {},
});

describe('RequestLedger', () => {
  it('new → replay returns the stored result verbatim', () => {
    const ledger = new RequestLedger();
    expect(ledger.begin('s1', 'r1', 'fp')).toEqual({ kind: 'new' });
    const res = result('r1');
    ledger.complete('s1', 'r1', res);
    const replay = ledger.begin('s1', 'r1', 'fp');
    expect(replay.kind).toBe('replay');
    expect((replay as { kind: 'replay'; result: CoreResult }).result).toBe(res);
  });

  it('reports pending for an in-flight duplicate', () => {
    const ledger = new RequestLedger();
    expect(ledger.begin('s1', 'r1', 'fp').kind).toBe('new');
    expect(ledger.begin('s1', 'r1', 'fp').kind).toBe('pending');
    expect(ledger.get('s1', 'r1')).toBeUndefined();
  });

  it('reports conflict for the same id with a different fingerprint', () => {
    const ledger = new RequestLedger();
    ledger.begin('s1', 'r1', 'fp-a');
    expect(ledger.begin('s1', 'r1', 'fp-b')).toEqual({ kind: 'conflict' });
    ledger.complete('s1', 'r1', result('r1'));
    expect(ledger.begin('s1', 'r1', 'fp-b')).toEqual({ kind: 'conflict' });
  });

  it('dedupes per session', () => {
    const ledger = new RequestLedger();
    ledger.begin('s1', 'r1', 'fp');
    expect(ledger.begin('s2', 'r1', 'fp').kind).toBe('new');
    // A different session may reuse the same id+fingerprint without conflict.
    expect(ledger.begin('s2', 'r1', 'fp').kind).toBe('pending');
  });

  it('evicts the oldest completed record past retention', () => {
    const ledger = new RequestLedger({ retention: 2 });
    for (const id of ['a', 'b', 'c']) {
      ledger.begin('s', id, `f${id}`);
      ledger.complete('s', id, result(id));
    }
    // 'a' evicted, 'b' and 'c' still replayable.
    expect(ledger.begin('s', 'a', 'fa')).toEqual({ kind: 'new' });
    expect(ledger.begin('s', 'b', 'fb').kind).toBe('replay');
    expect(ledger.begin('s', 'c', 'fc').kind).toBe('replay');
  });

  it('does not count pending records toward retention', () => {
    const ledger = new RequestLedger({ retention: 2 });
    ledger.begin('s', 'a', 'fa');
    ledger.complete('s', 'a', result('a'));
    // Many in-flight requests must not push the completed record 'a' out.
    for (const id of ['p1', 'p2', 'p3', 'p4']) ledger.begin('s', id, 'f');
    expect(ledger.begin('s', 'a', 'fa').kind).toBe('replay');
    for (const id of ['p1', 'p2', 'p3', 'p4'])
      expect(ledger.begin('s', id, 'f').kind).toBe('pending');
  });

  it('never evicts pending records (an in-flight retry must not execute twice)', () => {
    const ledger = new RequestLedger({ retention: 1 });
    ledger.begin('s', 'slow', 'f');
    for (const id of ['x', 'y', 'z']) {
      ledger.begin('s', id, 'f');
      ledger.complete('s', id, result(id));
    }
    expect(ledger.begin('s', 'slow', 'f')).toEqual({ kind: 'pending' });
  });

  it('get returns stored results only', () => {
    const ledger = new RequestLedger();
    ledger.begin('s', 'a', 'fa');
    expect(ledger.get('s', 'a')).toBeUndefined();
    const res = result('a');
    ledger.complete('s', 'a', res);
    expect(ledger.get('s', 'a')).toBe(res);
    expect(ledger.get('s', 'missing')).toBeUndefined();
    expect(ledger.get('other-session', 'a')).toBeUndefined();
  });

  it('abandon drops a pending reservation so a retry runs as new', () => {
    const ledger = new RequestLedger();
    ledger.begin('s', 'a', 'fa');
    expect(ledger.abandon('s', 'a')).toBe(true);
    expect(ledger.begin('s', 'a', 'fb')).toEqual({ kind: 'new' });
    ledger.complete('s', 'a', result('a'));
    expect(ledger.abandon('s', 'a')).toBe(false);
    expect(ledger.abandon('s', 'nope')).toBe(false);
  });

  it('snapshot/restore round-trips records, recency order and pending reservations', () => {
    const ledger = new RequestLedger();
    ledger.begin('s', 'a', 'fa');
    ledger.complete('s', 'a', result('a'));
    ledger.begin('s', 'b', 'fb');
    ledger.begin('s', 'c', 'fc');
    ledger.complete('s', 'c', result('c'));
    ledger.begin('s2', 'a', 'fa2');
    const snap = JSON.parse(JSON.stringify(ledger.snapshot())) as ReturnType<
      RequestLedger['snapshot']
    >;

    const copy = new RequestLedger();
    copy.restore(snap);
    expect(copy.snapshot()).toEqual(ledger.snapshot());
    expect(copy.begin('s', 'a', 'fa')).toMatchObject({ kind: 'replay', result: result('a') });
    expect(copy.begin('s', 'b', 'fb')).toEqual({ kind: 'pending' });
    expect(copy.begin('s', 'a', 'other')).toEqual({ kind: 'conflict' });
    expect(copy.pendingIds()).toEqual([
      { session: 's', id: 'b' },
      { session: 's2', id: 'a' },
    ]);
    copy.complete('s', 'b', result('b'));
    expect(copy.pendingIds()).toEqual([{ session: 's2', id: 'a' }]);
  });

  it('restore applies the current retention to completed records only', () => {
    const big = new RequestLedger({ retention: 10 });
    for (const id of ['a', 'b', 'c', 'd']) {
      big.begin('s', id, `f${id}`);
      big.complete('s', id, result(id));
    }
    big.begin('s', 'p', 'fp');
    const small = new RequestLedger({ retention: 2 });
    small.restore(big.snapshot());
    expect(small.get('s', 'a')).toBeUndefined();
    expect(small.get('s', 'b')).toBeUndefined();
    expect(small.get('s', 'c')).toBeDefined();
    expect(small.get('s', 'd')).toBeDefined();
    expect(small.begin('s', 'p', 'fp')).toEqual({ kind: 'pending' });
  });
});
