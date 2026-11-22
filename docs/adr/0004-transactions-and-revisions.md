# ADR 0004: Transactions and revisions

Status: Accepted, 2026-11-22

## Context

Two clients, or one client on two devices, can edit the same project. A client that edits without knowing the current state can overwrite another client's work. Undo, proposals and receipts all need a stable notion of "the state this change was made against".

Operations on the model are not all reversible by themselves, and a failed multi-step edit must not leave the project half changed.

## Decision

1. **Every write names its base.** A write action carries `baseRevision`. If it does not equal the current revision, the host returns `conflict` and changes nothing. The exceptions are `proposal.reject`, `asset.import` and `job.cancel`, which do not change project state.
2. **Revisions are opaque and linear.** In the reference host a revision is `rev-<n>`, incremented once per accepted state. Clients MUST NOT parse it.
3. **Transactions are atomic.** A transaction applies all its operations to a copy. If any operation fails, or the invariant set fails, or scope fails, nothing is committed and the revision does not change.
4. **Validation is separate from commit.** `transaction.validate` runs the same pipeline and returns the result without committing. Validation failure is a `succeeded` result with `valid: false`, so the client gets a diagnostic list rather than an error (`validateTransaction`, reference host).
5. **Receipts record outcomes.** Each commit, proposal acceptance, undo and redo produces a receipt. Receipts are retained up to `receiptRetention` and retrievable with `receipt.get`.
6. **Undo is an inverse change.** Undo applies the inverse of the recorded change set (`invertChanges`). If the inverse does not apply to the current state, the host returns `undo_conflict`.
7. **Pending requests are never dropped.** The idempotency ledger keeps a pending request until it completes. Clients retry with the same id to learn the outcome (`SPECIFICATION.md` section 6.4).

## Consequences

- Clients must read the current revision before writing. A read-modify-write without that read gets `conflict` and must retry.
- Concurrent edits on different entities still conflict, because the revision is project-wide. This is simple and correct; it is not fine-grained. A future version could allow disjoint transactions to rebase.
- Undo is only as good as the inverse. If another change touches the same entities, the inverse may not apply, and the result is `undo_conflict`, not a silent merge.- Storing full receipts costs memory. The retention limit bounds it, but a host that needs longer history must persist receipts itself.

## Alternatives considered

- **Last-writer-wins without a base.** Rejected. It loses edits silently.
- **Operational transformation or CRDTs.** Rejected for v0.1. They solve a different problem, concurrent editing of the same text, and they add a large amount of state. Project-wide revisions are enough for a client-server editor.
- **Per-entity revisions.** Rejected for v0.1. It would make every write carry many bases and would complicate scope and proposals. Recorded as a possible future change.
- **Commit on validate.** Rejected. A client that only wants to check a change should not change state.
- **Undo by stored snapshots.** Rejected. Snapshots cost memory proportional to the project size per step. Inverse changes cost memory proportional to the change.
