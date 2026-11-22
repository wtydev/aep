# ADR 0001: MEP Core 1 compatibility

Status: Accepted, 2026-11-22

## Context

AEP needs a request envelope, a manifest, a state shape, an idempotency rule and an error vocabulary. MEP Core 1 (`mep/core/1`) defines these for a family of MEP domain profiles. AEP is one domain profile.

Two things need to be kept separate:

- MEP Core 1 itself, which is the envelope and the mechanics shared by profiles.
- MEP 1 (`mep/1`), a separate video-oriented protocol with a different envelope and different protocol strings. Its research notes show that its envelope differs from Core 1.

Core 1 does not define domain actions, transactions, revisions, scope, proposals, history, assets, jobs or capability names. AEP needs all of these.

A vendored copy of the Core 1 JSON Schema is kept under `tests/fixtures/mep-core/core.schema.json`. It comes from upstream commit `6672c03b037d96aa4210d7091287e609e705efe5`, licensed Apache-2.0 per the fixture README.

## Decision

AEP uses the Core 1 envelope verbatim. A request is:

```
{ protocol, session, workspace, id, credential, action, version, baseRevision?, params }
```

A result is:

```
{ protocol, session, workspace, id, status, revision?, output?, error? }
```

`protocol` is `mep/core/1`. The manifest and state are closed objects with the fields defined by Core 1. `status` is one of `succeeded`, `rejected`, `failed`, `indeterminate`. An `indeterminate` result carries `error.next = reconcile`.

AEP adds its domain on top, and does not alter the envelope:

- 20 actions with fixed effects and roles (`SPECIFICATION.md` section 7),
- transactions, revisions, receipts and diffs (sections 8 to 10),
- scope, proposals, history, assets, jobs and capabilities (sections 11 to 16),
- a 27-code error vocabulary, each code's `next` a member of the Core enum (section 18).

The test in `tests/mep-core-compat.test.ts` validates AEP fixtures against the vendored schema. It checks that extra top-level fields are rejected, that a result without `error` is rejected, that `succeeded` with `error` is rejected, and that every AEP `next` value is in the Core enum. It does not check each code's `status` against the Core schema.

AEP makes no claim of interoperability with MEP 1 or with any other MEP implementation. No third-party implementation of Core 1 has been found in the research notes. The vendored schema test is the only conformance evidence.

The gaps AEP fills, which Core 1 does not define:

1. domain operations on a structured audio project,
2. transactions with base-revision checks and validation without commit,
3. revisions and receipts,
4. scope limits checked against the actual diff,
5. proposals with stale detection,
6. undo and redo,
7. host-side assets and provenance,
8. asynchronous jobs that do not change state,
9. capability names for domain features.

## Consequences

- Clients written against Core 1 can parse AEP envelopes unchanged.
- Any change to the vendored schema MUST be reflected by updating the pinned commit and re-running the test.
- A reader MUST NOT take the vendored test as evidence that AEP is a conforming MEP Core 1 implementation. Conformance of AEP is defined by `specs/core/SPECIFICATION.md` section 20.
- Core 1's durability requirement, as recorded in the research notes (not in the vendored schema), requires a reservation to be durable before an effect. The reference ledger is in memory (`ledger.ts`). AEP therefore does not yet claim that durability. This is an open item.

## Alternatives considered

- **Use MEP 1 (`mep/1`) as the envelope.** Rejected. It is a different protocol for a different domain, with a different envelope. Adopting it would make AEP look like a video profile and would not match any existing Core 1 consumer.
- **Define a private envelope.** Rejected. It would give up the one piece of shared structure available, and it would force every client to learn a new envelope.
- **Extend the Core 1 envelope with domain fields.** Rejected. The envelope is closed (`additionalProperties: false`). Adding fields would break the vendored test and any Core 1 parser.
- **Claim interoperability with MEP in general.** Rejected. There is no second implementation to test against, and the research notes show the profiles differ.
