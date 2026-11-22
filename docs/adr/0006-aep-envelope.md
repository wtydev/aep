# ADR 0006: AEP envelope

Status: Accepted, 2026-11-22. Supersedes [ADR 0001](0001-mep-core-compatibility.md).

## Context

ADR 0001 made AEP a domain profile of MEP Core 1. AEP used the Core 1 envelope verbatim, with the protocol identifier `mep/core/1`. A vendored copy of the upstream Core 1 JSON Schema was the only external conformance evidence.

That arrangement has three costs for AEP 1.0:

- AEP's envelope changes when an external schema changes. AEP does not control that schema.
- AEP cannot make stability promises for its envelope under its own semantic version. Its compatibility depends on another project's revisions.
- The vendored schema test checks AEP against one upstream revision. It says nothing about AEP's own rules, and it does not show interoperability with any MEP implementation. No such implementation was tested.

AEP 1.0 is a standalone protocol. It needs an envelope it owns, with its own stability guarantees (`SPECIFICATION.md` section 16.4).

## Decision

AEP owns its envelope. The protocol identifier is `aep/1`. The `protocol` field changes only with a new protocol major version.

Kept from v0.1, unchanged:

- The request shape `{protocol, session, workspace, id, credential, action, version, baseRevision?, params}`.
- The result shape `{protocol, session, workspace, id, status, revision?, output?, error?}`, and the four statuses `succeeded`, `rejected`, `failed` and `indeterminate`.
- The error shape `{code, next, message}`, and `error.next = reconcile` for `indeterminate`.
- The manifest and state shapes, with closed objects.

The shapes were sound, and existing v0.1 clients parse them. Changing them would cost compatibility without a gain.

Changed:

- The protocol identifier: `mep/core/1` becomes `aep/1`.
- The manifest file in the directory binding: `mep.json` becomes `aep.json`.
- The vendored MEP schema and its test (`tests/mep-core-compat.test.ts`, `tests/fixtures/mep-core/`) are removed. `tests/envelope.test.ts` checks AEP's own schemas.
- The specification and the design notes no longer describe AEP as a profile of MEP. AEP makes no claim about MEP.
- The durability rules that ADR 0001 left open are now defined in AEP itself (`SPECIFICATION.md` section 17).

## Consequences

- AEP 1.0 breaks wire compatibility with the v0.1 draft. A v0.1 client MUST use `aep/1` as the protocol identifier, and a directory client MUST read `aep.json`. The v0.1 draft made no stability promise, so this break is not a breach of one.
- Within 1.x, the envelope changes by addition only (`SPECIFICATION.md` section 16.4). A removal or a semantic change needs protocol 2.0, and so a new `protocol` value.
- AEP makes no interoperability claim with MEP or any other protocol. Conformance is defined by `SPECIFICATION.md` section 21 and `specs/core/CONFORMANCE.md`.

## Alternatives considered

- **Keep the MEP Core 1 envelope.** Rejected. AEP would keep depending on an external schema it does not control, and its 1.x promise would depend on another project's revisions.
- **Define a different envelope.** Rejected. The v0.1 shapes are sound. A new shape would cost every client a rewrite and gain nothing.
- **Keep the vendored schema test as the envelope check.** Rejected. It checks against one external revision and cannot check AEP's own rules.
