# AEP Transport Specification

Status: AEP v0.1 (draft, normative for implementers). Envelope and actions are in `specs/core/SPECIFICATION.md`.

## 1. Transport independence

A transport carries MEP Core 1 requests and results between a client and a host. A transport MUST NOT change any field of a request or result, MUST NOT add fields to them, and MUST NOT interpret `params`, `output` or `error` beyond framing.

A host's behaviour MUST NOT depend on the transport. The same request sent through any binding MUST yield the same result, subject to transport-specific framing limits in sections 2 to 4.

A host exposes a request handler with `handle(request)`, `state()` and `manifest()`. Bindings call it. A binding serving one session MAY use a handler bound to that session (the reference host provides `forSession(sessionId)`).

## 2. Directory binding

The directory binding exchanges files in one directory shared by a client and a host on the same machine.

### 2.1 Layout

```
<dir>/
  mep.json           manifest (CoreManifest)
  state.json         state (CoreState)
  requests/          client-written requests
  results/           host-written results
```

`mep.json` and `state.json` are written by the host. `mep.json` is written when the host starts. `state.json` is written when the host starts and again after every processed request. A client reads both files.

### 2.2 Request flow

1. The client writes the request as JSON to a fresh temporary file `requests/.<id>.<random>.tmp`, created exclusively (it fails if the name exists).
2. The client creates `requests/<id>.json` as a hard link to the temporary file, then removes the temporary file. If `<id>.json` already exists, the link fails with `EEXIST` and the send fails at the transport level, before the host sees anything. The client MUST NOT overwrite an existing request file.
3. The host scans `requests/` periodically (default every 50 ms). It ignores names that start with `.` or do not end in `.json`, and orders the rest by modification time and then by name.
4. The host processes requests one at a time. A request file larger than 4 MiB is not read; it yields a `bad_request` result. A file that is not valid JSON also yields `bad_request`.
5. The host passes each parsed request to the handler and writes the result to `results/<name>.json` atomically: it writes a temporary file and renames it into place.
6. The host then removes the request file and rewrites `state.json`.
7. The client polls `results/<id>.json` at a fixed interval (default 50 ms), reads it, and validates it against the result schema.

If the handler throws, the host writes a `failed` result with `internal_error`.

### 2.3 Result file naming

`<name>` is the result's `id` when that id matches `^[A-Za-z0-9._:-]{1,128}$`. Otherwise `<name>` is the request file's stem when the stem matches the same pattern, and `invalid` when it does not.

A host MUST NOT write a result file whose name does not match the pattern. A client MUST NOT use a request id that contains `/`, `\` or `..`.

### 2.4 Timeouts and reconciliation

The client waits for a result for up to a timeout (default 30 seconds). A timeout is not a failure of the request: it may still be in progress or may have completed. The reference client reports a timeout as an error to its caller, not as a result.

After a timeout, the client MUST retry with the same id and the same request body, or MUST treat the outcome as `indeterminate` and reconcile. Under the ledger rules (`SPECIFICATION.md` section 6), a retry returns the stored result or `busy`.

A retry uses the same file name as the original. If the host has not yet removed the original request file, the retry fails with `EEXIST` (step 2), and the client SHOULD poll `results/<id>.json` instead of resending. If the host has removed it, the retry is processed and answered from the ledger.

### 2.5 Permissions

- A host creates directories with mode `0700`. A host and a client create files with mode `0600`.
- A host and a client sharing the directory MUST run as the same user, or MUST use a directory whose access is restricted to them.

### 2.6 Security notes

- A request file holds the session credential in plaintext until the host removes it. An implementation SHOULD remove the request file as soon as it has been read, and MUST NOT leave request files in a location that other users can read.
- A result file does not contain the credential. A host MUST NOT place the credential in `mep.json`, `state.json` or any result.
- The directory is a local trust boundary. Any process that can write to `requests/` as the same user can submit requests. The binding provides no protection against that process.
- A host MUST NOT expose host filesystem paths through the directory. Asset descriptors carry no paths (`SPECIFICATION.md` section 14).

## 3. Stdio NDJSON binding

The stdio binding runs the host as a child process. Requests and results are exchanged as newline-delimited JSON on the child's standard input and standard output.

### 3.1 Framing

Each message is one JSON document on one line, terminated by `\n`. A host MUST accept `\r\n` terminators.

- The host writes exactly one hello line first: `{"type":"hello","manifest":CoreManifest}`.
- A line that is a JSON object without a `protocol` field and with `type` equal to `state` or `manifest` is a meta request. The host answers with `{"type":"state","state":CoreState}` or `{"type":"manifest","manifest":CoreManifest}`.
- Any other line is a CoreRequest.
- The host answers each request with `{"type":"result","result":CoreResult}`.

A CoreRequest has no `type` field (`SPECIFICATION.md` section 4) and always has `protocol`, so the meta and request forms do not collide.

### 3.2 Concurrency

The host processes requests concurrently. Results MAY be returned out of order. A client MUST correlate results with requests by `id`.

State and manifest replies are returned in the order their requests arrived.

At end of input, the host finishes in-flight requests, flushes their results, and then exits.

If the handler throws, the host answers with a `failed` result with `internal_error`. Its `id` is the request's `id` when that is a valid request id, and `invalid` otherwise.

### 3.3 Limits

- A line longer than 4 MiB is rejected.
- A line that is not valid JSON is rejected.
- Both rejections produce `{"type":"result","result":{...}}` with a `bad_request` error and `id` set to `invalid`. After an over-long line, the host discards input up to the next newline.

### 3.4 Client behaviour

- The client MUST keep pending requests in a map keyed by `id`. A caller MUST NOT send a request whose id is still pending.
- A result line that fails validation MUST be surfaced to the caller. A client SHOULD apply a timeout to each request and reconcile as in section 2.4.
- Non-normative, reference client: it rejects a send whose id is still pending. An invalid result line fails the matching request, or every pending request when its id cannot be matched. Lines that are not JSON objects are ignored. `send`, `state()` and `manifest()` time out after `requestTimeoutMs` (default 120 s). Input bytes are decoded as a UTF-8 stream, so a character split across reads is kept intact.
- When the host's output ends or errors, or the host process exits or fails to start, the reference client rejects `hello` (if still pending), every pending call, and every later call.

### 3.5 Process handling

- The reference client starts the host without a shell and inherits standard error.
- A host MUST NOT write credentials or request bodies to standard error.

### 3.6 Security notes

- The child process runs with the client's privileges. The client MUST start only hosts it trusts.
- Any process that can write to the host's standard input can submit requests for any session whose credential it knows. Credentials are the only protection.
- Standard error may reach logs. Hosts SHOULD log only request ids, actions and result codes.

## 4. In-memory binding

The in-memory binding calls a request handler in the same process.

- Requests and results are deep-copied through JSON. A binding MUST NOT pass object references between the client and the host.
- The binding performs no framing and imposes no size limit beyond the host's own `maxRequestBytes`.
- The binding is for tests and embedding. It provides no isolation: the host and client share memory, so a credential held by the client is visible to any code in the process.

## 5. Choosing a binding

| Binding   | Use                                                    | Isolation                | Size limit             |
| --------- | ------------------------------------------------------ | ------------------------ | ---------------------- |
| Directory | Same-machine clients that cannot spawn a child process | Same user                | 4 MiB per request      |
| Stdio     | Clients that spawn a host as a child process           | Child process, same user | 4 MiB per line         |
| In-memory | Tests and embedding                                    | None                     | Host `maxRequestBytes` |

A host advertising several bindings MUST enforce the same authentication, ledger and validation rules in each. A binding-specific limit MAY reject a request that the host would otherwise accept. The binding then returns `bad_request` for the framing limit and the host is not involved. The 4 MiB caps are fixed and are not derived from the host's `maxRequestBytes` (`SPECIFICATION.md` section 17), so the two can disagree.
