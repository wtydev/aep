# AEP v0.1 conformance

A host conforms to AEP v0.1 at a given level when it passes every test of that level in the
conformance suite (`@aep/testing`) and the MEP Core 1 envelope checks. The suite is black-box: it
talks to the host only through a transport binding, so hosts in any language can be tested.

## Running

```sh
pnpm install && pnpm run build
pnpm run conformance                      # reference host as a separate process (stdio)
node packages/testing/dist/cli.js         # reference engine in-process
node packages/testing/dist/cli.js --json -- ./my-host --my-flag
node packages/testing/dist/cli.js --list  # every test id
```

A third-party host plugs in by implementing the **launcher contract** (CLI flags `--transport`,
`--fixture`, `--session-config`, `--import-root`, `--executors`, credentials written to files with
mode 0600, never passed on argv). The contract is specified in
[`packages/testing/README.md`](../../packages/testing/README.md#launcher-contract). Hosts that serve
one session per process may pass `--no-multi-session`; tests that need several sessions are then
skipped.

## Levels

| Level       | Tests | Required capabilities                      | Covers                                                                                                                                                                                                                                                                                                          |
| ----------- | ----: | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`      |    36 | `aep.core`                                 | envelope validity against MEP Core 1, id echo, unknown action, unsupported version, `bad_request`, auth and roles, manifest filtering, idempotent replay and `id_conflict`, stale/missing `baseRevision`, transaction atomicity, `transaction.validate` does not mutate, receipts and `receipt.get` diagnostics |
| `audio`     |    47 | `aep.audio.*` per test                     | tracks (add/remove/reorder, type compatibility), clips (insert/move/trim/split/duplicate math, 17 tests), MIDI notes and events, tempo, meter, sections, routing incl. cycle rejection, devices, automation, asset link/unlink                                                                                  |
| `proposals` |    15 | `aep.proposals`                            | isolation from accepted state, `includeState`, accept, clean accept after unrelated change, stale detection, reject/closed, scope on create, replay                                                                                                                                                             |
| `history`   |    12 | `aep.history`                              | undo restores content as a new revision, multi-step undo, undo by id, `undo_conflict`, `nothing_to_undo`, redo, redo cleared by a new commit, undoing an accepted proposal                                                                                                                                      |
| `assets`    |    12 | `aep.audio.assets.import`                  | import from a declared root, WAV sniffing, traversal/absolute/unknown-root rejection, no host paths in output, asset absent from the project until `asset.link`                                                                                                                                                 |
| `jobs`      |    14 | `aep.jobs`, `aep.render`, `aep.generation` | render lifecycle, render bound to a revision or proposal, cancel, `job_not_cancellable`, deterministic generation by seed, jobs never mutate project state                                                                                                                                                      |
| `security`  |    22 | `aep.core`                                 | clip/track/timeRange/operations/properties scopes incl. indirect effects, transaction scope narrows but never widens session scope, scope on undo and accept, credential never echoed, bad credentials leave no trace, limits advertised and enforced                                                           |

A level is **achieved** when it has at least one pass and no failures. Tests whose capabilities the
host does not declare in `aep.capabilities` are reported as skipped, not failed. A host claiming
"AEP v0.1 conformant" MUST achieve `core`, `audio` and `security`; `proposals`, `history`, `assets`
and `jobs` are optional profiles and MUST be achieved if their capabilities are declared.

## Envelope compatibility

`tests/mep-core-compat.test.ts` validates sample AEP requests, results (succeeded, rejected,
indeterminate), manifests and state documents against the vendored MEP Core 1
`core.schema.json` (upstream commit `6672c03b037d96aa4210d7091287e609e705efe5`), and checks that every
AEP error code uses a valid MEP `next` value. This shows AEP documents are valid MEP Core 1
documents. It does **not** show interoperability with any MEP implementation; none was tested.

## Reference results

Reference host (`examples/minimal-host`) over stdio, 2026-11-22: 158 passed, 0 failed, 0 skipped;
all seven levels achieved. Reproduce with `pnpm run conformance`.

## Not covered by the suite

Durability across host restarts, concurrent multi-client contention beyond request ordering,
real audio rendering correctness, and performance. These need host-specific testing.
