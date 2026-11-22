# @wty.dev/aep-host — AEP reference host

Reference implementation of an AEP host engine: sessions and credentials, transactions and
proposals, undo/redo history, asset import, and render/generation jobs, all over one project
with a single-reference-swap commit. Implements the host side of the transport contract
(`RequestHandler`), so it can be served over stdio, a directory binding, or in-process.

The host is volatile by default (`new AepHost(...)`). `await AepHost.open({ dataDir, ... })`
opens a durable host that persists projects, sessions, the request ledger, receipts, history,
proposals, assets and jobs across restarts
([`SPECIFICATION.md`](../../specs/core/SPECIFICATION.md) section 17).

```sh
pnpm add @wty.dev/aep-host
```

```ts
import { AepHost, demoProject, referenceExecutors } from '@wty.dev/aep-host';

const host = new AepHost({ project: demoProject(), executors: referenceExecutors() });
const { session, credential, workspace } = host.createSession({
  client: 'my-app',
  role: 'edit',
});
// serve `host` via @wty.dev/aep-transport (serveStdio / DirectoryHostBinding) or InMemoryTransport
```

A durable host:

```ts
import { AepHost, demoProject } from '@wty.dev/aep-host';

// `dataDir` must be an absolute path. The constructor throws if it is given `dataDir`.
const host = await AepHost.open({ project: demoProject(), dataDir: '/var/lib/my-app/aep' });
const grant = host.createSession({ client: 'my-app', role: 'edit' });
await host.flush(); // sessions are written in the background; this makes them durable
```

If `<dataDir>/host-state.json` exists, `AepHost.open` restores from it and ignores `project`.
Writes are persisted before a request answers `succeeded`. Jobs that were queued or running at
shutdown restart as `failed`. There is no lock on `dataDir`: run one host per directory.

`demoProject()` returns a fresh 120 bpm project; `referenceExecutors()` provides deterministic
render and generation executors for the jobs API. Pass `importRoots: { inbox: '/abs/dir' }` to
allow `asset.import` from named directories. The protocol is specified in
[`specs/core/SPECIFICATION.md`](../../specs/core/SPECIFICATION.md).
