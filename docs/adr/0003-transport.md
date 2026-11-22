# ADR 0003: Transport

Status: Accepted, 2026-11-22

## Context

A host needs to answer requests from clients on the same machine, from clients that spawn it as a child process, and from tests in the same process. Each setting has different isolation and framing needs. The protocol must not change between them, or clients would need a different envelope per setting.

## Decision

The host implements one `RequestHandler` (`packages/transport/src/types.ts`). Three bindings call it:

1. **Directory.** Requests are files in `requests/`, results are files in `results/`, and two host-written files hold the manifest and state. Modes are `0700` for directories and `0600` for files. The client creates requests with `link()` so that an existing id is detected. The host sorts requests by modification time and name, and enforces a 4 MiB limit per request.
2. **Stdio NDJSON.** The host runs as a child process. It writes one hello line, then answers meta lines and requests, one JSON document per line. Requests may be pipelined and results may return out of order. A line over 4 MiB, or invalid JSON, produces `bad_request` with id `invalid`.
3. **In-memory.** A direct call, with requests and results deep-copied through JSON.

The envelope and the result shapes are identical across all three. A binding MUST NOT change them. Transport limits are framing limits; they do not change host rules.

A host serving one session can expose a session-bound handler through `forSession`.

Full binding rules are in `specs/core/TRANSPORT.md`.

## Consequences

- A client can switch bindings without changing its request code.
- Authentication, ledger and validation run in the host, not in the binding. A binding cannot skip them.
- The directory binding is a local trust boundary. A process that can write to `requests/` as the same user can submit requests. The binding relies on credentials and file modes.
- The directory binding stores the credential in the request file until the host removes it. This is documented as a security note, and implementations are expected to remove the file promptly.
- The reference stdio client does not meet the client requirements in `TRANSPORT.md` section 3.4: it overwrites the pending entry for a duplicate id, drops invalid result lines, and has no default timeout. These are fixes to make, not properties to keep.
- The 4 MiB caps of the directory and stdio bindings are not derived from the host's `maxRequestBytes` limit. The two can disagree.

## Alternatives considered

- **HTTP.** Rejected for v0.1. It adds a server, a port and a TLS question, none of which the target use case needs. A future binding can add it without changing the envelope.
- **A single binding.** Rejected. Directory and stdio are for different clients, and the in-memory binding is needed for tests.
- **Length-prefixed frames instead of NDJSON.** Rejected for stdio. NDJSON is readable in a terminal and sufficient for one request per line.
- **Let each binding define its own envelope.** Rejected. It would break transport independence and the vendored Core test would no longer cover every binding.
