import { describe, expect, it } from 'vitest';
import type { CoreResult } from '@aep/schema';
import { RequestLedger } from './ledger.js';

const result = (id: string): CoreResult => ({
  protocol: 'mep/core/1',
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
});
