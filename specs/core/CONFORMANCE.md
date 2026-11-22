# AEP 1.0 conformance

A host conforms to AEP 1.0 at a given level when it passes every test of that level in the
conformance suite (`@wty.dev/aep-testing`) and the envelope checks in `tests/envelope.test.ts`. The suite is
black-box: it talks to the host only through a transport binding, so hosts in any language can be
tested.

## Running

```sh
pnpm install && pnpm run build
pnpm run conformance                      # reference host as a separate process (stdio), all levels
node packages/testing/dist/cli.js         # reference engine in-process
node packages/testing/dist/cli.js --json -- ./my-host --my-flag
node packages/testing/dist/cli.js --no-restart -- ./my-host   # skip the durability level
node packages/testing/dist/cli.js --list  # every test id
```

A third-party host plugs in by implementing the **launcher contract** (CLI flags `--transport`,
`--fixture`, `--session-config`, `--import-root`, `--executors`, credentials written to files with
mode 0600, never passed on argv). The contract is specified in
[`packages/testing/README.md`](../../packages/testing/README.md#launcher-contract). Hosts that serve
one session per process may pass `--no-multi-session`; tests that need several sessions are then
skipped.

A host that is durable (`host.durability: durable`, section 17) additionally implements
`--data-dir <dir>`: the launcher starts it with an empty data directory, kills it with SIGKILL and
starts it again with the identical command line. On every start the host restores its state and
its sessions from `<dir>`; it creates the sessions of `--session-config` on the first start only and
keeps their credentials. A host that does not start with `--data-dir` is probed without it, and the
`durability` level is skipped.

## Levels

| Level        | Tests | Required capabilities                      | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ----: | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`       |    39 | `aep.core`                                 | envelope validity, id echo, unknown action, unsupported action version, `bad_request` (including the retired `mep/core/1` protocol id), `aep.capabilities` (protocol 1.0, schema 1.0.0, durability class), protocol version negotiation (`[1.0, 1.7]`, `[1.7]` → 1.0; `[0.1]`, `[2.0]` → `unsupported_version`), auth and roles, manifest filtering, idempotent replay and `id_conflict`, stale/missing `baseRevision`, transaction atomicity, `transaction.validate` does not mutate, receipts and `receipt.get` diagnostics |
| `audio`      |    54 | `aep.audio.*` per test                     | tracks (add/remove/reorder, type compatibility), clips (insert/move/trim/split/duplicate math, 20 tests), MIDI notes and events, tempo incl. linear ramps and their duration, meter, sections, routing incl. cycle and duplicate-send rejection, devices incl. targeting-lane blocks, automation, asset link/unlink, source bounds and loop bounds (invariant 15), `audio/midi` assets, duplicate note ids in a batch                                                                                                         |
| `proposals`  |    15 | `aep.proposals`                            | isolation from accepted state, `includeState`, accept, clean accept after unrelated change, stale detection, reject/closed, scope on create, replay                                                                                                                                                                                                                                                                                                                                                                           |
| `history`    |    12 | `aep.history`                              | undo restores content as a new revision, multi-step undo, undo by id, `undo_conflict`, `nothing_to_undo`, redo, redo cleared by a new commit, undoing an accepted proposal                                                                                                                                                                                                                                                                                                                                                    |
| `assets`     |    12 | `aep.audio.assets.import`                  | import from a declared root, WAV sniffing, traversal/absolute/unknown-root rejection, no host paths in output, asset absent from the project until `asset.link`                                                                                                                                                                                                                                                                                                                                                               |
| `jobs`       |    14 | `aep.jobs`, `aep.render`, `aep.generation` | render lifecycle, render bound to a revision or proposal, cancel, `job_not_cancellable`, deterministic generation by seed, jobs never mutate project state                                                                                                                                                                                                                                                                                                                                                                    |
| `security`   |    22 | `aep.core`                                 | clip/track/timeRange/operations/properties scopes incl. indirect effects, transaction scope narrows but never widens session scope, scope on undo and accept, credential never echoed, bad credentials leave no trace, limits advertised and enforced                                                                                                                                                                                                                                                                         |
| `durability` |     8 | `aep.core`, `host.durability: durable`     | `SPECIFICATION.md` section 17, across a SIGKILL restart over the same data directory: project and revision, request-id replay (and `id_conflict`), `receipt.get` of committed and rejected requests, `history.undo` / `redo` of a pre-restart commit, an open proposal that can still be accepted, the session credential (still valid, wrong ones still refused), an imported store asset, a finished job's state and result; replay and receipt tests skip when `receiptRetention` is too small                             |

A level is **achieved** when it has at least one pass and no failures. Tests whose capabilities the
host does not declare in `aep.capabilities` are reported as skipped, not failed. A host claiming
"AEP 1.0 conformant" MUST achieve `core`, `audio` and `security`; `proposals`, `history`, `assets`
and `jobs` are optional profiles and MUST be achieved if their capabilities are declared.

The `durability` level is opt-in. A launcher MAY run it; it needs launcher support for restarts (the
`--data-dir` contract above). A host that reports `host.durability: durable` MUST achieve it. For a
host that reports `volatile`, or when the launcher cannot restart the host, its tests are reported as
skipped and the host is not required to achieve this level.

## Envelope checks

The envelope checks live in `tests/envelope.test.ts`. They validate sample AEP requests, results
(succeeded, rejected, failed, indeterminate), manifests and state documents against the published
schemas in `schemas/`, and check that every error code carries a `next` value from the defined set.

## Reference results

`pnpm run conformance` against the reference host (`examples/minimal-host`, run as a separate
process over stdio, `--data-dir` for the durability level), AEP 1.0, schema 1.0.0:

```text
Summary
  core       39 passed, 0 failed, 0 skipped  ACHIEVED
  audio      54 passed, 0 failed, 0 skipped  ACHIEVED
  proposals  15 passed, 0 failed, 0 skipped  ACHIEVED
  history    12 passed, 0 failed, 0 skipped  ACHIEVED
  assets     12 passed, 0 failed, 0 skipped  ACHIEVED
  jobs       14 passed, 0 failed, 0 skipped  ACHIEVED
  security   22 passed, 0 failed, 0 skipped  ACHIEVED
  durability 8 passed, 0 failed, 0 skipped  ACHIEVED

Total: 176 passed, 0 failed, 0 skipped (176 tests, 4.1 s)
Levels achieved: core, audio, proposals, history, assets, jobs, security, durability
```

The in-process run of the reference engine (`node packages/testing/dist/cli.js`) gives the same
result. `tests/conformance/reference-host.test.ts` runs both on every `pnpm exec vitest run` and
requires every level, `durability` included, to be achieved with nothing skipped.

## Not covered by the suite

Concurrent multi-client contention beyond request ordering, real audio rendering correctness, and
performance. These need host-specific testing. The `durability` level covers a restart of the host
after a SIGKILL; it does not cover the persistence of assets and jobs across restarts, torn writes,
a full disk, or the `outcome_uncertain` result of a request that was reserved but unfinished at the
crash (the suite cannot crash a host mid-request). Those need host-specific tests.
