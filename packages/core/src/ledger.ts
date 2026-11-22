import type { CoreResult } from '@aep/schema';

interface LedgerRecord {
  fingerprint: string;
  /** Present once `complete` has been called; absent while the request is executing. */
  result?: CoreResult;
}

interface SessionLedger {
  /** Insertion / recency order; completed and pending records interleaved. */
  records: Map<string, LedgerRecord>;
  /** Number of records in `records` that have a result. */
  completed: number;
}

export type LedgerBegin =
  | { kind: 'new' }
  | { kind: 'replay'; result: CoreResult }
  | { kind: 'pending' }
  | { kind: 'conflict' };

/**
 * Request dedup ledger keyed by (session, request id). Same id + same fingerprint returns the
 * stored result verbatim (replay), or `pending` while still executing; same id + different
 * fingerprint is an `id_conflict`. At most `retention` *completed* records are kept per session
 * (least recently used evicted). Pending records do not count toward retention and are never
 * evicted: dropping one would let a retry of an in-flight request execute twice.
 */
export class RequestLedger {
  private readonly retention: number;
  private readonly sessions = new Map<string, SessionLedger>();

  constructor(opts?: { retention?: number }) {
    this.retention = opts?.retention ?? 1000;
  }

  begin(session: string, id: string, fingerprint: string): LedgerBegin {
    let ledger = this.sessions.get(session);
    if (!ledger) {
      ledger = { records: new Map(), completed: 0 };
      this.sessions.set(session, ledger);
    }
    const { records } = ledger;
    const existing = records.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { kind: 'conflict' };
      if (existing.result !== undefined) {
        records.delete(id);
        records.set(id, existing);
        return { kind: 'replay', result: existing.result };
      }
      return { kind: 'pending' };
    }
    records.set(id, { fingerprint });
    return { kind: 'new' };
  }

  complete(session: string, id: string, result: CoreResult): void {
    const ledger = this.sessions.get(session);
    const record = ledger?.records.get(id);
    if (!ledger || !record || record.result !== undefined) return;
    record.result = result;
    ledger.completed += 1;
    // Evict the oldest completed records, skipping pending ones, once over retention.
    for (const [key, rec] of ledger.records) {
      if (ledger.completed <= this.retention) break;
      if (rec.result !== undefined) {
        ledger.records.delete(key);
        ledger.completed -= 1;
      }
    }
  }

  get(session: string, id: string): CoreResult | undefined {
    return this.sessions.get(session)?.records.get(id)?.result;
  }
}
