# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-22

First stable release of the Audio Edit Protocol.

### Added

- **Breaking:** AEP has its own wire envelope, `protocol: "aep/1"`. AEP 1.0 is a standalone
  protocol and does not depend on or reference any other protocol.
- **Breaking:** the directory-binding manifest is named `aep.json`.
- **Breaking:** Protocol versioning is now `1.0`: versions are `MAJOR.MINOR`, and from 1.0
  onward same-major versions are mutually compatible (the highest common `MAJOR.MINOR` is
  negotiated).
- Tempo ramps: `TempoPoint.curve` (`step` | `linear`) shapes the segment to the next tempo
  point.
- Defined `loop.length` units on clips.
- Durable reference host: `AepHost.open({ dataDir })` persists state with write-ahead
  reservations; hosts declare `host.durability` in `aep.capabilities`; retrying an interrupted
  request yields `outcome_uncertain` instead of a duplicate execution.
- New invariants enforced by hosts: automation lane targets a device on the same track,
  automation points are sorted and unique, no duplicate sends, audio clips reference an `audio/*`
  asset other than `audio/midi`, clip sources respect bounds; `effect.remove`/`instrument.set` reject orphaning automation
  lanes; `midi.notes.add` rejects duplicate note ids within a batch.
- README for every published package.
- Conformance level `durability`: the launcher passes `--data-dir <dir>` and restarts the host;
  skipped for hosts that report `host.durability: volatile`.
- Durable host hardening: a job starts only after the request that created it is durable; a
  rejected request whose final write fails is rolled back; if even the `outcome_uncertain` answer
  cannot be persisted the host refuses further requests until restarted; `dataDir`, `assets/` and
  the state file must be owned by the host user, not symlinks, and not group/other-writable;
  stored blobs are hash-checked before reuse.
- The published `core-result` JSON Schema encodes the status rules (`succeeded` needs `revision`
  and `output`; other statuses need `error`; `indeterminate` needs `next: reconcile`).
- `SessionRole` schema (`@wty.dev/aep-schema`) and `DurableHostOptions` (`@wty.dev/aep-host`).
- Release workflow: pushing a `v*` tag builds, checks the generated schemas, type-checks, tests
  and runs the conformance suite, verifies that every package version matches the tag, publishes
  all `@wty.dev/aep-*` packages to npm with provenance, then creates a GitHub release.

### Changed

- **Breaking:** linear tempo ramps are specified with `log1p`/`expm1` (mathematically equal to the
  previous `ln`/`exp` forms) so nearly flat ramps keep full precision.
- **Breaking:** `asset.import` rejects a path whose final component is a symbolic link, even one that
  points inside the import root (§14); symlinked directories inside the root are still followed.
- Executors cannot store an invalid asset descriptor or report an asset that is not in the store.
- A replayed request refreshes its receipt along with its ledger entry, so both evict together.
- The example host revokes and reissues a session whose `--session-config` entry changed.
- The conformance launcher SIGKILLs the host before closing its transports, so a restart is a
  real crash.

- **Breaking:** `RequestHandler` is defined once, in `@wty.dev/aep-core`; `@wty.dev/aep-host`
  and `@wty.dev/aep-transport` re-export it.
- **Breaking:** `@wty.dev/aep-host` no longer exports `ManifestRenderer`, `PatternGenerator` or
  `mulberry32`; use `referenceExecutors()` and the executor ids.
- `@wty.dev/aep-testing` takes `@wty.dev/aep-host` as an optional peer dependency, needed only by
  the in-process launcher.
- All `@wty.dev/aep-*` packages publish with `publishConfig.access: public` and provenance attestations;
  `workspace:*` dependency ranges are rewritten to `1.0.0` on publish.

## [0.1.0] - 2026-11-22

### Added

- Initial protocol draft: the audio domain model, operation set, and action table.
- Reference SDK (`@wty.dev/aep-schema`, `@wty.dev/aep-core`, `@wty.dev/aep-host`, `@wty.dev/aep-client`, `@wty.dev/aep-transport`,
  `@wty.dev/aep-testing`) implementing the protocol over the local binding.
- Conformance suite (`pnpm run conformance`) and published JSON Schemas under `schemas/`.
