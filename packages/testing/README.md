# @wty.dev/aep-testing — AEP conformance suite

Black-box tests for AEP hosts (Audio Edit Protocol, `aep/1`). Every test gets a fresh
host and talks to it only through the wire protocol, so the suite can check any implementation,
in any language, that follows the launcher contract below.

```sh
# reference engine, in-process
aep-conformance

# any host process
aep-conformance -- node examples/minimal-host/dist/main.js
aep-conformance --json --level core,audio -- ./my-host --my-flag
```

## CLI

```
aep-conformance [options] [-- <host command...>]
```

| Flag                 | Meaning                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `--json`             | Machine-readable report on stdout.                               |
| `--level a,b`        | Only these levels.                                               |
| `--filter text`      | Only tests whose id contains `text`.                             |
| `--concurrency n`    | Tests in parallel, each with its own host (default 4).           |
| `--timeout ms`       | Per-test timeout (default 60000).                                |
| `--no-multi-session` | Skip tests needing more than one session (single-session hosts). |
| `--no-restart`       | Never pass `--data-dir` or restart the host: skips `durability`. |
| `--list`             | List the tests and exit.                                         |
| `--help`             | Usage.                                                           |

Exit code: 0 when every executed test passed, 1 on any failure, 2 on a usage error.

## Levels

`core`, `audio`, `proposals`, `history`, `assets`, `jobs`, `security` and the opt-in `durability`.
A level is _achieved_ when it has no failures and at least one pass. Tests declare the capabilities
they need; if the host does not declare them in `aep.capabilities` the test is skipped, not failed.

`durability` commits, kills the host, starts it again over the same data directory and checks what
survived: project and revision, request-id replay, `receipt.get`, `history.undo`/`redo`, an open
proposal and the session credential. Its tests are **skipped** (not failed) when the host reports
`host.durability: volatile`, or when the launcher cannot restart the host (see below).

## Launcher contract

A launcher gives the suite a fresh host and one connected `AepClient` per requested session.
Two are built in: `InProcessLauncher` (the `@wty.dev/aep-host` engine over an in-memory transport) and
`ProcessLauncher(command, args, options)`, which spawns a host process as follows.

```
<command> <args...> --transport stdio|directory [--dir <dir>] --fixture <file>
          --session-config <file> --import-root inbox=<dir> --executors reference
          [--data-dir <dir>]
```

- `--fixture <file>`: the AEP project (JSON) to serve.
- `--session-config <file>`: `{"sessions":[{"client","role","scope"?,"credentialFile"}]}`. For each
  session the host generates a credential and writes it to `credentialFile` (trailing newline
  allowed, mode `0600`). Then it writes `<credentialFile>.session.json` = `{"session","workspace"}`.
  That descriptor is written last.
- One session is served over `--transport stdio` (the host prints its hello on stdout, so logs must
  go to stderr). Several sessions are served over `--transport directory --dir <dir>`, with the
  session's binding in `<dir>/<session>/` (the AEP directory binding).
- `--import-root inbox=<dir>`: the only directory `asset.import` may read from. It holds
  `tone.wav` and `notes.json`.
- `--executors reference`: enable deterministic render and generation executors. The jobs level
  relies on these.
- `--data-dir <dir>` (only for the `durability` level): an empty directory the host persists all
  its state in (SPECIFICATION.md section 17). The host is durable and reports
  `host.durability: durable` when it gets the flag. The suite stops the host with **SIGKILL** and
  starts it again with the **identical command line**, so on every start the host must:
  - restore project, revision, ledger, receipts, history, proposals, assets and sessions from
    `<dir>` (the `--fixture` only seeds an empty `<dir>`);
  - create the sessions of `--session-config` on the first start only. On later starts the sessions
    still exist: it must keep them, with the same ids and credentials, and must not rewrite the
    credential files or the `.session.json` descriptors (the launcher keeps using the credentials
    it read at the first start). It persists a session before it writes its credential file.
    A host that cannot start with `--data-dir` is probed without it and the durability tests are
    skipped. Restart is supported for one stdio session only.
- Credentials are never passed on the command line. The suite kills the host with SIGTERM when the
  test ends (SIGKILL for restarts) and deletes its temporary directory.

A host that can only serve one session passes `--no-multi-session` (or
`multiSession: false`), and tests needing several sessions are skipped. `--no-restart` (or
`restart: false`) disables `--data-dir` and the durability level.

## Programmatic use

```ts
import { ProcessLauncher, runSuite, formatHuman } from '@wty.dev/aep-testing';

const report = await runSuite({
  launcher: new ProcessLauncher('node', ['dist/host.js']),
  levels: ['core'],
});
console.log(formatHuman(report));
process.exitCode = report.totals.failed > 0 ? 1 : 0;
```

A custom launcher implements `HostLauncher { name; launch(opts): Promise<LaunchedHost> }`, where
`LaunchedHost` is `{ clients, credentials, restart?(), close() }`. Throw `UnsupportedLaunch` to skip
a test the launcher cannot set up. When `opts.restart` is set the launcher must give the host a
persistent data directory and return a `restart()` that kills the host, starts it again over the
same directory and updates `clients` and `credentials` in place (or throw `UnsupportedLaunch` if
it cannot). `InProcessLauncher` restarts by reopening `AepHost.open({ dataDir })`.
