/**
 * @wty.dev/aep-core — domain-independent coordination utilities shared by hosts, clients and transports.
 *
 * CONTRACT (implemented in the modules re-exported below):
 *
 * errors.ts
 *   class AepError extends Error { code: ErrorCode; diagnostics: Diagnostic[]; status; next }
 *     constructor(code: ErrorCode, message: string, diagnostics?: Diagnostic[])
 *     toCoreError(): CoreError          // message truncated to 1200 code points, never leaks secrets
 *   isAepError(e: unknown): e is AepError
 *
 * canonical.ts
 *   canonicalJson(value: unknown): string   // RFC 8785-style: sorted keys, no whitespace; undefined dropped
 *   sha256Hex(data: string | Uint8Array): string
 *   requestFingerprint(req: CoreRequest): string  // sha256 of canonicalJson of req minus `credential`
 *
 * version.ts
 *   SUPPORTED_PROTOCOL_VERSIONS: readonly string[]          // ['1.0']
 *   negotiateVersion(client: readonly string[], host: readonly string[]): string | null
 *     // versions are 'MAJOR.MINOR'. Same MAJOR is compatible (before 1.0, only identical
 *     // versions). A compatible pair negotiates to its lower version; the highest such result wins.
 *   isCompatible(a: string, b: string): boolean
 *
 * ledger.ts  — AEP dedup by (session, request id)
 *   class RequestLedger {
 *     constructor(opts?: { retention?: number })              // max records kept per session, default 1000
 *     begin(session: string, id: string, fingerprint: string):
 *       | { kind: 'new' }                                      // identity reserved, caller executes then complete()
 *       | { kind: 'replay'; result: CoreResult }               // same id+fingerprint, finished: return stored result verbatim
 *       | { kind: 'pending' }                                  // same id+fingerprint, still executing
 *       | { kind: 'conflict' }                                 // same id, different fingerprint -> id_conflict
 *     complete(session: string, id: string, result: CoreResult): void
 *     get(session: string, id: string): CoreResult | undefined
 *     abandon(session: string, id: string): boolean          // drop a pending record (nothing ran)
 *     pendingIds(): { session: string; id: string }[]
 *     snapshot(): LedgerSnapshot / restore(snapshot: LedgerSnapshot): void   // for durable hosts
 *   }
 *   // After restore(), a durable host MUST complete every pendingIds() entry with an
 *   // `outcome_uncertain` result (SPECIFICATION §17): the ledger itself has no error policy.
 *
 * handler.ts
 *   interface RequestHandler { handle(req: unknown): Promise<CoreResult>; manifest(); state() }
 *     // host side of a transport binding; implemented by hosts, consumed by transports
 *
 * entities.ts — generic entity-map diff used for receipts, scope checks, undo/redo and proposals
 *   interface EntityRecord { entity: EntityKind; value: unknown }   // value is a JSON value WITHOUT child collections
 *   type EntityMap = Map<string, EntityRecord>                      // key = entity path, e.g. '/tracks/t1/clips/c1'
 *   diffEntities(before: EntityMap, after: EntityMap): Change[]
 *     // deterministic order: removes (deepest path first), then adds (shallowest first), then updates
 *     // (path order). Update includes `fields` = sorted top-level keys whose values differ (deep equality).
 *   invertChanges(changes: Change[]): Change[]                      // reverse order, add<->remove, swap before/after
 *   applyChanges(map: EntityMap, changes: Change[]): EntityMap
 *     // returns a NEW map; throws AepError('undo_conflict') if for any change the current value at path
 *     // is not deepEqual to change.before (remove/update) or the path already exists (add).
 *   deepEqual(a: unknown, b: unknown): boolean
 *
 * paths.ts — authorized-root path resolution (no symlink / traversal escape)
 *   resolveInsideRoot(root: string, relative: string): Promise<string>
 *     // rejects (AepError 'path_rejected') absolute paths, drive letters, backslashes, NUL, empty or
 *     // '.'/'..' segments, and any path whose realpath is outside realpath(root). Returns absolute real path.
 *
 * match.ts
 *   matchesOperationPattern(op: string, pattern: string): boolean   // '*' or 'midi.notes.*' or exact
 *
 * security.ts
 *   constantTimeEqual(a: string, b: string): boolean
 *   generateCredential(): string                                     // 32 random bytes base64url
 *   generateId(prefix: string): string                               // prefix + '-' + 16 hex chars, matches the AEP id charset
 */
export * from './errors.js';
export * from './canonical.js';
export * from './version.js';
export * from './ledger.js';
export * from './entities.js';
export * from './paths.js';
export * from './match.js';
export * from './security.js';
export type { RequestHandler } from './handler.js';
