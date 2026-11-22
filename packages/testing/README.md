# @aep/testing — AEP conformance suite

Black-box tests for AEP hosts (MEP Core 1, Audio Edit Protocol profile). Every test gets a fresh
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
| `--list`             | List the tests and exit.                                         |
| `--help`             | Usage.                                                           |

Exit code: 0 when every executed test passed, 1 on any failure, 2 on a usage error.

## Levels

`core`, `audio`, `proposals`, `history`, `assets`, `jobs`, `security`. A level is _achieved_ when
it has no failures and at least one pass. Tests declare the capabilities they need; if the host
does not declare them in `aep.capabilities` the test is skipped, not failed.

## Launcher contract

A launcher gives the suite a fresh host and one connected `AepClient` per requested session.
Two are built in: `InProcessLauncher` (the `@aep/host` engine over an in-memory transport) and
`ProcessLauncher(command, args, options)`, which spawns a host process as follows.

```
<command> <args...> --transport stdio|directory [--dir <dir>] --fixture <file>
          --session-config <file> --import-root inbox=<dir> --executors reference
```

- `--fixture <file>`: the AEP project (JSON) to serve.
- `--session-config <file>`: `{"sessions":[{"client","role","scope"?,"credentialFile"}]}`. For each
  session the host generates a credential and writes it to `credentialFile` (trailing newline
  allowed, mode `0600`). Then it writes `<credentialFile>.session.json` = `{"session","workspace"}`.
  That descriptor is written last.
- One session is served over `--transport stdio` (the host prints its hello on stdout, so logs must
  go to stderr). Several sessions are served over `--transport directory --dir <dir>`, with the
  session's binding in `<dir>/<session>/` (the MEP directory binding).
- `--import-root inbox=<dir>`: the only directory `asset.import` may read from. It holds
  `tone.wav` and `notes.json`.
- `--executors reference`: enable deterministic render and generation executors. The jobs level
  relies on these.
- Credentials are never passed on the command line. The suite kills the host with SIGTERM when the
  test ends and deletes its temporary directory.

A host that can only serve one session passes `--no-multi-session` (or
`multiSession: false`), and tests needing several sessions are skipped.

## Programmatic use

```ts
import { ProcessLauncher, runSuite, formatHuman } from '@aep/testing';

const report = await runSuite({
  launcher: new ProcessLauncher('node', ['dist/host.js']),
  levels: ['core'],
});
console.log(formatHuman(report));
process.exitCode = report.totals.failed > 0 ? 1 : 0;
```

A custom launcher implements `HostLauncher { name; launch(opts): Promise<LaunchedHost> }`, where
`LaunchedHost` is `{ clients, credentials, close() }`. Throw `UnsupportedLaunch` to skip a test
the launcher cannot set up.
