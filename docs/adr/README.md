# Architecture decision records

Each record states one decision, why it was made, and what it costs. Records are numbered in the order they were accepted. A record is not edited to reverse a decision; a new record supersedes it.

| ADR                                        | Title                      | Status               |
| ------------------------------------------ | -------------------------- | -------------------- |
| [0001](0001-mep-core-compatibility.md)     | MEP Core 1 compatibility   | Accepted, 2026-11-22 |
| [0002](0002-canonical-model.md)            | Canonical model            | Accepted, 2026-11-22 |
| [0003](0003-transport.md)                  | Transport                  | Accepted, 2026-11-22 |
| [0004](0004-transactions-and-revisions.md) | Transactions and revisions | Accepted, 2026-11-22 |
| [0005](0005-extension-architecture.md)     | Extension architecture     | Accepted, 2026-11-22 |

Normative text lives in `specs/`:

- `specs/core/SPECIFICATION.md`: protocol
- `specs/core/TRANSPORT.md`: bindings
- `specs/audio/AUDIO-DOMAIN.md`: domain model and operations
