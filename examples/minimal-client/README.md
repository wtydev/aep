# aep-demo-client

A scripted tour of AEP from the client side. It spawns the reference host
(`examples/minimal-host`) as an independent process, passes the credential through a temporary
file (never argv, never printed), and runs nine steps. It exits non-zero on any deviation.

```sh
pnpm demo                                                     # builds, then runs over stdio
node examples/minimal-client/dist/main.js --transport directory
```

## Options

| Flag                           | Meaning                                               |
| ------------------------------ | ----------------------------------------------------- |
| `--transport stdio\|directory` | How to talk to the host (default `stdio`).            |
| `--host <path>`                | Host entry point (default: the minimal host's build). |
| `--help`                       | Usage.                                                |

## The tour

1. `aep.capabilities` — what the host offers
2. inspect the project
3. commit a transaction (track, clip, notes) and read the receipt
4. create and read a proposal
5. accept the proposal
6. undo and redo
7. render a job, wait for it, list the stored asset
8. idempotent retry: the same request id applies once (a different request under the same id is
   `id_conflict`; that check is skipped on the directory binding, whose result files are keyed by
   request id)
9. scope violation: a scoped transaction touching another clip is rejected, and `receipt.get`
   explains why

On success it prints `demo complete: every step behaved as expected.`; otherwise
`demo FAILED: <reason>` and exit code 1.
