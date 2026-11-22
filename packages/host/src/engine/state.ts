/**
 * Shape and validation of `host-state.json` (format version 1).
 *
 * This is exactly what a durable host persists: the accepted project with its revision and
 * revision counter; sessions (credential HASH only); the request ledger and the reservations
 * still open in it; request records (for `receipt.get`); history with undo/redo targets as
 * indexes into `history`; proposals (open ones with their proposed project); asset descriptors
 * (bytes live in `assets/<sha256 hex>`); and job records.
 */
import {
  ACTIONS,
  Asset,
  Change,
  CoreResult,
  Diagnostic,
  HistoryEntry,
  Job,
  Project,
  Proposal,
  Receipt,
  ResultStatus,
  Scope,
  SessionRole,
} from '@wty.dev/aep-schema';
import type {
  Asset as AssetT,
  Change as ChangeT,
  Diagnostic as DiagnosticT,
  HistoryEntry as HistoryEntryT,
  Job as JobT,
  Project as ProjectT,
  Proposal as ProposalT,
  Receipt as ReceiptT,
  Scope as ScopeT,
} from '@wty.dev/aep-schema';
import type { LedgerSnapshot } from '@wty.dev/aep-core';
import { STATE_FORMAT_VERSION } from './persistence.js';

export type Role = SessionRole;

export interface PersistedSession {
  id: string;
  client: string;
  role: Role;
  scope?: ScopeT;
  allowedActions?: string[];
  expiresAt: number;
  revoked: boolean;
  /** sha256 hex of the credential. The credential itself is never stored. */
  credentialHash: string;
}

export interface PersistedHistory {
  entry: HistoryEntryT;
  changes: ChangeT[];
  sessionId: string;
  /** Index into `history` of the record an undo/redo entry reverted or reapplied. */
  target?: number;
}

export interface PersistedProposal {
  proposal: ProposalT;
  /** Present only while the proposal is open. */
  proposed?: ProjectT;
  proposerScope?: ScopeT;
}

export interface PersistedRequestRecord {
  action: string;
  status: ResultStatus;
  errorCode?: string;
  diagnostics: DiagnosticT[];
  receipt?: ReceiptT;
}

export interface PersistedState {
  formatVersion: typeof STATE_FORMAT_VERSION;
  project: ProjectT;
  revision: string;
  revisionCounter: number;
  sessions: PersistedSession[];
  ledger: LedgerSnapshot;
  /** Action names of requests whose reservation is open (for `receipt.get` after a restart). */
  reservations: { session: string; id: string; action: string }[];
  records: { session: string; records: { id: string; record: PersistedRequestRecord }[] }[];
  history: PersistedHistory[];
  proposals: PersistedProposal[];
  /** Descriptors only; bytes are in `assets/<contentHash hex>`. */
  assets: AssetT[];
  jobs: JobT[];
}

const fail = (what: string): never => {
  throw new Error(`corrupt host state: ${what}`);
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const obj = (v: unknown, what: string): Record<string, unknown> =>
  isObj(v) ? v : fail(`${what} must be an object`);
const arr = (v: unknown, what: string): unknown[] =>
  Array.isArray(v) ? v : fail(`${what} must be an array`);
const str = (v: unknown, what: string): string =>
  typeof v === 'string' ? v : fail(`${what} must be a string`);
const int = (v: unknown, what: string): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0
    ? v
    : fail(`${what} must be a non-negative integer`);

interface Parseable {
  safeParse(value: unknown): { success: boolean };
}

/** Validate against a schema but keep the original value (so stored results stay byte-identical). */
function check<T>(schema: Parseable, value: unknown, what: string): T {
  return schema.safeParse(value).success ? (value as T) : fail(`${what} does not match its schema`);
}

/** Hex digest of an asset's `contentHash` (`sha256:<hex>`). */
export function assetBlobName(asset: AssetT): string {
  const m = /^sha256:([0-9a-f]{64})$/.exec(asset.contentHash ?? '');
  return m ? m[1]! : fail(`asset '${asset.id}' has no sha256 contentHash`);
}

/** Parse and validate a decoded state file. Throws on an unknown format version or any malformed part. */
export function parsePersistedState(raw: unknown): PersistedState {
  const root = obj(raw, 'host-state.json');
  if (root['formatVersion'] !== STATE_FORMAT_VERSION) {
    throw new Error(
      `unsupported host-state formatVersion ${JSON.stringify(root['formatVersion'])}; this host reads version ${STATE_FORMAT_VERSION}`,
    );
  }
  const history = arr(root['history'], 'history').map((h, i): PersistedHistory => {
    const r = obj(h, `history[${i}]`);
    const target = r['target'];
    if (target !== undefined && int(target, `history[${i}].target`) >= i) {
      fail(`history[${i}].target must point to an earlier entry`);
    }
    return {
      entry: check<HistoryEntryT>(HistoryEntry, r['entry'], `history[${i}].entry`),
      changes: check<ChangeT[]>(Change.array(), r['changes'], `history[${i}].changes`),
      sessionId: str(r['sessionId'], `history[${i}].sessionId`),
      ...(target !== undefined ? { target: target as number } : {}),
    };
  });
  const ledger = obj(root['ledger'], 'ledger');
  return {
    formatVersion: STATE_FORMAT_VERSION,
    project: check<ProjectT>(Project, root['project'], 'project'),
    revision: str(root['revision'], 'revision'),
    revisionCounter: int(root['revisionCounter'], 'revisionCounter'),
    sessions: arr(root['sessions'], 'sessions').map((s, i): PersistedSession => {
      const r = obj(s, `sessions[${i}]`);
      const role = str(r['role'], `sessions[${i}].role`);
      if (!SessionRole.safeParse(role).success) fail(`sessions[${i}].role is unknown`);
      const allowed = r['allowedActions'];
      const actions =
        allowed === undefined
          ? undefined
          : arr(allowed, `sessions[${i}].allowedActions`).map((a) => {
              const name = str(a, `sessions[${i}].allowedActions[]`);
              return Object.hasOwn(ACTIONS, name) ? name : fail(`unknown action '${name}'`);
            });
      if (typeof r['revoked'] !== 'boolean') fail(`sessions[${i}].revoked must be a boolean`);
      return {
        id: str(r['id'], `sessions[${i}].id`),
        client: str(r['client'], `sessions[${i}].client`),
        role: role as Role,
        ...(r['scope'] !== undefined
          ? { scope: check<ScopeT>(Scope, r['scope'], `sessions[${i}].scope`) }
          : {}),
        ...(actions ? { allowedActions: actions } : {}),
        expiresAt: int(r['expiresAt'], `sessions[${i}].expiresAt`),
        revoked: r['revoked'] as boolean,
        credentialHash: str(r['credentialHash'], `sessions[${i}].credentialHash`),
      };
    }),
    ledger: {
      sessions: arr(ledger['sessions'], 'ledger.sessions').map((s, i) => {
        const r = obj(s, `ledger.sessions[${i}]`);
        return {
          session: str(r['session'], `ledger.sessions[${i}].session`),
          records: arr(r['records'], `ledger.sessions[${i}].records`).map((x, j) => {
            const rec = obj(x, `ledger record ${i}/${j}`);
            return {
              id: str(rec['id'], `ledger record ${i}/${j}.id`),
              fingerprint: str(rec['fingerprint'], `ledger record ${i}/${j}.fingerprint`),
              ...(rec['result'] !== undefined
                ? {
                    result: check<CoreResult>(CoreResult, rec['result'], `ledger result ${i}/${j}`),
                  }
                : {}),
            };
          }),
        };
      }),
    },
    reservations: arr(root['reservations'], 'reservations').map((x, i) => {
      const r = obj(x, `reservations[${i}]`);
      return {
        session: str(r['session'], `reservations[${i}].session`),
        id: str(r['id'], `reservations[${i}].id`),
        action: str(r['action'], `reservations[${i}].action`),
      };
    }),
    records: arr(root['records'], 'records').map((s, i) => {
      const r = obj(s, `records[${i}]`);
      return {
        session: str(r['session'], `records[${i}].session`),
        records: arr(r['records'], `records[${i}].records`).map((x, j) => {
          const e = obj(x, `records[${i}][${j}]`);
          const rec = obj(e['record'], `records[${i}][${j}].record`);
          const status = str(rec['status'], 'record.status');
          if (!ResultStatus.safeParse(status).success) fail('record.status is unknown');
          return {
            id: str(e['id'], `records[${i}][${j}].id`),
            record: {
              action: str(rec['action'], 'record.action'),
              status: status as ResultStatus,
              ...(rec['errorCode'] !== undefined
                ? { errorCode: str(rec['errorCode'], 'record.errorCode') }
                : {}),
              diagnostics: check<DiagnosticT[]>(
                Diagnostic.array(),
                rec['diagnostics'],
                'record.diagnostics',
              ),
              ...(rec['receipt'] !== undefined
                ? { receipt: check<ReceiptT>(Receipt, rec['receipt'], 'record.receipt') }
                : {}),
            },
          };
        }),
      };
    }),
    history,
    proposals: arr(root['proposals'], 'proposals').map((p, i): PersistedProposal => {
      const r = obj(p, `proposals[${i}]`);
      return {
        proposal: check<ProposalT>(Proposal, r['proposal'], `proposals[${i}].proposal`),
        ...(r['proposed'] !== undefined
          ? { proposed: check<ProjectT>(Project, r['proposed'], `proposals[${i}].proposed`) }
          : {}),
        ...(r['proposerScope'] !== undefined
          ? {
              proposerScope: check<ScopeT>(
                Scope,
                r['proposerScope'],
                `proposals[${i}].proposerScope`,
              ),
            }
          : {}),
      };
    }),
    assets: arr(root['assets'], 'assets').map((a, i) => check<AssetT>(Asset, a, `assets[${i}]`)),
    jobs: arr(root['jobs'], 'jobs').map((j, i) => check<JobT>(Job, j, `jobs[${i}]`)),
  };
}
