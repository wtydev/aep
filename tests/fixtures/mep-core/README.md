# MEP Core 1 fixture

`core.schema.json` is the MEP Core 1 local-binding JSON Schema, copied unmodified from the
upstream MEP repository for AEP compatibility testing.

- Source repo: `MEP`
- Upstream commit: `6672c03b037d96aa4210d7091287e609e705efe5`
- Path: `schema/core.schema.json`
- License: Apache-2.0 (see `LICENSE` in this directory)

The schema defines four document kinds via `$defs` and a top-level `oneOf`: `manifest`,
`state`, `request`, and `result`. AEP documents are required to be valid instances of these
definitions; see `tests/mep-core-compat.test.ts`.
