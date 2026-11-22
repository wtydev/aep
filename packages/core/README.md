# @wty.dev/aep-core — AEP core utilities

Domain-independent coordination primitives shared by AEP hosts, clients and transports:
canonical JSON and request fingerprints, protocol version negotiation, the per-session request
ledger (idempotent dedup by request id), entity-map diffs for receipts and undo/redo, authorized
path resolution, operation-pattern matching, and credential helpers.

```sh
pnpm add @wty.dev/aep-core
```

```ts
import {
  RequestLedger,
  canonicalJson,
  generateCredential,
  negotiateVersion,
  requestFingerprint,
} from '@wty.dev/aep-core';
import type { CoreRequest, CoreResult } from '@wty.dev/aep-schema';

declare const req: CoreRequest;
declare function execute(req: CoreRequest): Promise<CoreResult>;

const ledger = new RequestLedger();
const begin = ledger.begin(req.session, req.id, requestFingerprint(req));
if (begin.kind === 'new') {
  const result = await execute(req);
  ledger.complete(req.session, req.id, result);
}
// 'replay'   → return begin.result verbatim
// 'pending'  → the first attempt is still running: answer `busy`
// 'conflict' → the id was used for a different request: answer `id_conflict`

canonicalJson({ b: 1, a: 2 }); // '{"a":2,"b":1}'
const credential = generateCredential(); // a fresh random secret
const version = negotiateVersion(['1.0'], ['1.0', '1.1']); // '1.0'
```

`requestFingerprint(req)` hashes the canonical request without `credential`. `RequestLedger`
keeps at most `retention` completed records per session (default 1000) and never evicts a
pending one.

See [`specs/core/SPECIFICATION.md`](../../specs/core/SPECIFICATION.md) for the wire semantics
these utilities implement.
