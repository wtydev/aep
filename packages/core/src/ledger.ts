import type { CoreResult } from '@wty.dev/aep-schema';

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

/** One ledger record in a snapshot: `result` is absent for a reserved (pending) request. */
export interface LedgerSnapshotRecord {
  id: string;
  fingerprint: string;
  result?: CoreResult;
}

/** Serializable copy of a ledger: per session, records in recency order (oldest first). */
export interface LedgerSnapshot {
  sessions: { session: string; records: LedgerSnapshotRecord[] }[];
}

/**
 * Request dedup ledger keyed by (session, request id). Same id + same fingerprint returns the
 * stored result verbatim (replay), or `pending` while still executing; same id + different
 * fingerprint is an `id_conflict`. At most `retention` *completed* records are kept per session
 * (least recently used evicted). Pending records do not count toward retention and are never
 * evicted: dropping one would let a retry of an in-flight request execute twice.
 *
 * `snapshot()` / `restore()` let a durable host persist the ledger. A reservation that was
 * pending when the host stopped is restored as pending; the host must then `complete` it
 * (typically with an `outcome_uncertain` result) before serving requests, see `pendingIds()`.
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
    this.evict(ledger);
  }

  /**
   * Drop a reservation that never executed (for example because it could not be made durable),
   * so that a retry runs as a new request. Returns false when there is no pending record.
   */
  abandon(session: string, id: string): boolean {
    const ledger = this.sessions.get(session);
    const record = ledger?.records.get(id);
    if (!ledger || !record || record.result !== undefined) return false;
    ledger.records.delete(id);
    return true;
  }

  get(session: string, id: string): CoreResult | undefined {
    return this.sessions.get(session)?.records.get(id)?.result;
  }

  /** Reserved records that have no result yet. */
  pendingIds(): { session: string; id: string }[] {
    const out: { session: string; id: string }[] = [];
    for (const [session, ledger] of this.sessions) {
      for (const [id, rec] of ledger.records) {
        if (rec.result === undefined) out.push({ session, id });
      }
    }
    return out;
  }

  /** Copy of every record (results are shared, not cloned: treat them as immutable). */
  snapshot(): LedgerSnapshot {
    return {
      sessions: [...this.sessions].map(([session, ledger]) => ({
        session,
        records: [...ledger.records].map(([id, rec]) => ({
          id,
          fingerprint: rec.fingerprint,
          ...(rec.result !== undefined ? { result: rec.result } : {}),
        })),
      })),
    };
  }

  /** Replace the whole ledger with `snapshot`, then apply this ledger's retention. */
  restore(snapshot: LedgerSnapshot): void {
    this.sessions.clear();
    for (const { session, records } of snapshot.sessions) {
      const ledger: SessionLedger = { records: new Map(), completed: 0 };
      for (const r of records) {
        ledger.records.set(r.id, {
          fingerprint: r.fingerprint,
          ...(r.result !== undefined ? { result: r.result } : {}),
        });
        if (r.result !== undefined) ledger.completed += 1;
      }
      this.evict(ledger);
      this.sessions.set(session, ledger);
    }
  }

  /** Evict the oldest completed records, skipping pending ones, once over retention. */
  private evict(ledger: SessionLedger): void {
    for (const [key, rec] of ledger.records) {
      if (ledger.completed <= this.retention) break;
      if (rec.result !== undefined) {
        ledger.records.delete(key);
        ledger.completed -= 1;
      }
    }
  }
}
