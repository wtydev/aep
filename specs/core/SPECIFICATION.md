# AEP Core Specification

Status: AEP v0.1 (draft, normative for implementers). Domain semantics are in `specs/audio/AUDIO-DOMAIN.md`. Bindings are in `specs/core/TRANSPORT.md`. Decisions are in `docs/adr/`.

## 1. Overview

AEP (Audio Edit Protocol) lets a client read, edit and version an audio project held by a host. A client sends requests; the host returns results. The protocol defines:

- sessions and roles that authorize requests,
- a fixed set of 20 actions,
- transactions that apply operations against a base revision,
- revisions, receipts and an idempotency ledger,
- scope limits on what a transaction may change,
- proposals, history (undo and redo), assets and asynchronous jobs,
- capability advertisement and version negotiation,
- a closed error vocabulary of 27 codes.

AEP is a domain profile of MEP Core 1 (section 3). It is not an implementation of MEP 1 (video).

## 2. Conformance language and terms

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in RFC 2119.

| Term        | Meaning                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| Host        | The party that holds project state and answers requests.                                              |
| Client      | The party that sends requests.                                                                        |
| Session     | An authenticated binding of a client to one workspace, with a role.                                   |
| Workspace   | One project, identified by `project.id`.                                                              |
| Revision    | An opaque string identifying the accepted state, `rev-<n>` in the reference host.                     |
| Transaction | An ordered list of operations plus an optional scope, committed or validated against a base revision. |
| Receipt     | The record of a committed or rejected transaction, proposal or history action.                        |
| Ledger      | The host's record of request ids per session, used for idempotency.                                   |

## 3. Relationship to MEP Core 1

AEP uses the MEP Core 1 protocol identifier `mep/core/1` and its envelope, manifest and state shapes. The envelope is defined in `docs/adr/0001-mep-core-compatibility.md`.

AEP adds, on top of Core 1:

- the 20 domain actions (section 7),
- transactions, revisions and receipts (sections 8 and 9),
- diffs, entity paths and scope (sections 10 and 11),
- proposals, history, assets, jobs and capability names (sections 12 to 16).

AEP makes no claim of interoperability with MEP 1 or with any other MEP implementation. The vendored Core schema test (`tests/mep-core-compat.test.ts`) checks AEP fixtures against one upstream Core schema revision and nothing more (`docs/adr/0001-mep-core-compatibility.md`).

`session`, `workspace` and `id` are strings of 1 to 100 characters from `A-Z a-z 0-9 _ -`. The workspace id is the project id.

## 4. Envelope

A request has these fields:

```
{ protocol, session, workspace, id, credential, action, version, baseRevision?, params }
```

- `protocol` is `mep/core/1`.
- `credential` is 1 to 512 characters. It MUST NOT be echoed in any result, receipt, diagnostic, manifest, state or log.
- `version` is an integer of at least 1. AEP v0.1 uses version 1 for every action.
- `baseRevision` is required for write actions except those listed in section 7.3.
- `params` is validated against the action's parameter schema.

A result has these fields:

```
{ protocol, session, workspace, id, status, revision?, output?, error? }
```

- `status` is one of `succeeded`, `rejected`, `failed`, `indeterminate`.
- A `succeeded` result MUST carry `revision` and `output`, and MUST NOT carry `error`.
- Every other status MUST carry `error` and MUST NOT carry `output`.
- An `indeterminate` result MUST carry `error.next = reconcile`.
- `error` is `{code, next, message}`. `message` is truncated to 1200 characters.

The shapes are published as `schemas/core-request.schema.json`, `schemas/core-result.schema.json`, `schemas/core-manifest.schema.json` and `schemas/core-state.schema.json`.

A manifest is a closed object (`additionalProperties: false`) `{protocol, session, workspace, expiresAt, actions, stateSchema}`. A host MUST list in `actions` only the actions the session may use (advertised capability, role and `allowedActions`). Each entry is `{id, version, effect, paramsSchema, resultSchema}`. `paramsSchema` and `resultSchema` are paths of the form `schemas/<action>-params.schema.json` and `schemas/<action>-result.schema.json`, with dots in the action id replaced by hyphens. `stateSchema` is `schemas/project.schema.json`.

A state object is `{protocol, session, workspace, revision, data}`, where `data` is the project at the current revision.

## 5. Validation order

A host MUST evaluate a request in this order and stop at the first failure:

1. **Envelope.** Parse the request against the envelope schema. Failure: `bad_request`, with the error describing the first failing path.
2. **Authenticate.** Identify the session and check the credential, revocation, expiry and workspace. Order: unknown session or credential mismatch: `not_authorized`; revoked: `session_revoked`; expired: `session_expired`; workspace mismatch: `not_authorized`. The host compares the SHA-256 hash of the credential with the stored hash in constant time, and does so even for an unknown session. Credentials are not stored.
3. **Check action.** In order: unknown action: `unknown_action`; `version` not equal to the action version: `unsupported_version`; capability not advertised: `capability_unsupported`; role or `allowedActions` does not permit the action: `not_authorized`; serialized request size above `maxRequestBytes`: `limit_exceeded`.
4. **Ledger.** Look up `(session, id)`. See section 6.3. Failures from steps 1 to 3 are not recorded in the ledger.
5. **Parameters.** Validate `params` against the action's schema. Failure: `invalid_params`, with the path.
6. **Base revision.** For write actions not in section 7.3, `baseRevision` MUST be present (`invalid_params` at `/baseRevision` if absent) and MUST equal the current revision, otherwise `conflict`.
7. **Execute.** Run the action. Its specific checks and their errors are in sections 8 to 16.

A host MUST NOT execute a write before step 6 succeeds. Results from step 4 other than a replay (`busy`, `id_conflict`) are not stored.

## 6. Sessions, roles and idempotency

### 6.1 Roles

Each session has one role. A role grants a fixed set of actions.

| Role      | Actions                                                                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`    | `aep.capabilities`, `project.inspect`, `project.describe`, `transaction.validate`, `receipt.get`, `proposal.list`, `proposal.get`, `history.list`, `asset.list`, `job.status` |
| `propose` | all of `read`, plus `proposal.create`, `render.request`, `generation.request`, `job.cancel`                                                                                   |
| `edit`    | all of `propose`, plus `transaction.commit`, `proposal.accept`, `proposal.reject`, `history.undo`, `history.redo`                                                             |
| `admin`   | all of `edit`, plus `asset.import`                                                                                                                                            |

A session MAY further restrict its actions with `allowedActions`. The effective permission is the intersection of the advertised capabilities, the role, and `allowedActions`.

### 6.2 Sessions

A session carries a session id, a workspace, a client name (1 to 128 characters), a role, an expiry, a revocation flag, an optional session scope (section 11) and optional `allowedActions`. Sessions are created out of band by the host's owner, not by a protocol action. In the reference host the default lifetime is one hour and the credential is returned once, at creation. A host MUST record only a hash of the credential. A host MUST NOT write a credential into state, receipts, diagnostics, manifests or logs.

### 6.3 Ledger

The ledger is keyed by `(session, id)`. For each request, the host computes `requestFingerprint(req)`, which is the SHA-256 of the canonical JSON of the request with `credential` removed. The ledger then returns one of four outcomes:

| Outcome    | Condition                                                 | Result                                                              |
| ---------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| `new`      | No record                                                 | Execute the request and record its result.                          |
| `replay`   | Record exists and fingerprint matches                     | Return the stored result unchanged. The record becomes most recent. |
| `pending`  | Record exists, fingerprint matches, execution in progress | `busy`.                                                             |
| `conflict` | Record exists and fingerprint differs                     | `id_conflict`.                                                      |

A host MUST NOT reuse an id for a different request in the same session. The ledger is per session. A host SHOULD retain at least `receiptRetention` records per session; the reference host counts only completed records toward that number and, once it is exceeded, evicts the least recently used completed records. A host MUST NOT evict a pending record.

A record is created for every request that passes step 3 of section 5, whatever its final status. `receipt.get` (section 7.1) reads these records; a request id that failed before step 4, or that has been evicted, has no record.

### 6.4 Reconciliation

A client that receives `outcome_uncertain` or a timeout MUST retry with the same id and the same request body. Under section 6.3 that returns the stored result, or `busy` if the first attempt is still running.

## 7. Actions

### 7.1 Action table

`write` actions require `baseRevision` unless listed in section 7.3.

| Action                 | Capability                | Effect | Params                                       | Output                                                           | Principal errors                                                                                         |
| ---------------------- | ------------------------- | ------ | -------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `aep.capabilities`     | `aep.core`                | read   | `{versions?}` (see 16.3)                     | capabilities object                                              | `unsupported_version`                                                                                    |
| `project.inspect`      | `aep.core`                | read   | none                                         | `{revision, project}`                                            | none                                                                                                     |
| `project.describe`     | `aep.core`                | read   | none                                         | project summary (counts, duration, tempo, meter)                 | none                                                                                                     |
| `transaction.validate` | `aep.core`                | read   | transaction                                  | `{valid, baseRevision, diagnostics, changes}`                    | see 8.2                                                                                                  |
| `transaction.commit`   | `aep.core`                | write  | transaction                                  | Receipt                                                          | `validation_failed`, `scope_violation`, `conflict`, `limit_exceeded`, `precondition_failed`, `not_found` |
| `receipt.get`          | `aep.core`                | read   | `{requestId}`                                | `{requestId, action, status, errorCode?, diagnostics, receipt?}` | `not_found`                                                                                              |
| `proposal.create`      | `aep.proposals`           | write  | `{transaction, proposalId?}`                 | Proposal                                                         | `limit_exceeded`, `precondition_failed`, `validation_failed`, `scope_violation`, `not_found`, `conflict` |
| `proposal.list`        | `aep.proposals`           | read   | `{status?}` (array of status strings)        | `{proposals}`                                                    | none                                                                                                     |
| `proposal.get`         | `aep.proposals`           | read   | `{proposalId, includeState}` (default false) | `{proposal, state?}`                                             | `not_found`                                                                                              |
| `proposal.accept`      | `aep.proposals`           | write  | `{proposalId}`                               | Receipt                                                          | `not_found`, `proposal_stale`, `proposal_closed`, `scope_violation`, `conflict`                          |
| `proposal.reject`      | `aep.proposals`           | write  | `{proposalId}`                               | Proposal                                                         | `not_found`, `proposal_closed`                                                                           |
| `history.list`         | `aep.history`             | read   | `{limit}` (1 to 1000, default 100)           | `{entries, canUndo, canRedo}`                                    | none                                                                                                     |
| `history.undo`         | `aep.history`             | write  | `{transactionId?}`                           | Receipt                                                          | `nothing_to_undo`, `not_found`, `precondition_failed`, `undo_conflict`, `scope_violation`                |
| `history.redo`         | `aep.history`             | write  | none                                         | Receipt                                                          | `nothing_to_redo`, `undo_conflict`, `scope_violation`                                                    |
| `asset.list`           | `aep.audio.assets`        | read   | `{store}` (default false)                    | `{assets}`                                                       | none                                                                                                     |
| `asset.import`         | `aep.audio.assets.import` | write  | `{path, root?, mediaType?, assetId?}`        | `{asset}`                                                        | `path_rejected`, `invalid_params`, `asset_not_found`, `precondition_failed`, `limit_exceeded`            |
| `render.request`       | `aep.render`              | write  | render parameters                            | `{job}`                                                          | `capability_unsupported`, `invalid_params`, `not_found`, `proposal_stale`, `proposal_closed`             |
| `generation.request`   | `aep.generation`          | write  | generation parameters                        | `{job}`                                                          | `not_found`, `invalid_params`                                                                            |
| `job.status`           | `aep.jobs`                | read   | `{jobId}`                                    | `{job}`                                                          | `not_found`                                                                                              |
| `job.cancel`           | `aep.jobs`                | write  | `{jobId}`                                    | `{job}`                                                          | `not_found`, `job_not_cancellable`                                                                       |

Every action can also fail with the pipeline errors of section 5. `transaction.validate` returns `succeeded` with `valid: false` and a diagnostic list when the transaction fails for any domain reason (operation, invariant, scope or limit). It does not return a rejected result for that case. At most 200 diagnostics are returned.

### 7.2 Action identifiers

Action ids match `^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$`.

### 7.3 Actions without baseRevision

Only these write actions do not require `baseRevision`: `proposal.reject`, `asset.import`, `job.cancel`. They do not change project state.

## 8. Transactions

### 8.1 Transaction shape

A transaction contains an ordered list of operations (the 31 operations in `AUDIO-DOMAIN.md` section 6), an optional `scope` (section 11), and optional metadata. A transaction MUST NOT contain more operations than `maxOperationsPerTransaction`; the host checks this before applying any operation and returns `limit_exceeded`.

### 8.2 Validation

`transaction.validate` applies the operations to a copy of the current state, runs the invariant set (`AUDIO-DOMAIN.md` section 7), and evaluates the session scope and the transaction scope. It returns `succeeded` with `valid`, `baseRevision`, `diagnostics` and `changes`. It does not change state and does not require `baseRevision`; the reported `baseRevision` is the current revision.

### 8.3 Commit

`transaction.commit` MUST perform, in order:

1. Apply the operations (`AUDIO-DOMAIN.md` section 6.1). A failure aborts the commit and is returned with the diagnostic for the failing operation.
2. Run the invariant set. Failure: `validation_failed`.
3. Compute the diff against the base state (section 10).
4. Evaluate the session scope and the transaction scope against the diff (section 11). Failure: `scope_violation`.
5. Assign the next revision and record a Receipt.

If any step fails, the revision does not change.

## 9. Revisions and receipts

### 9.1 Revisions

Each accepted state has one revision. In the reference host, revisions are `rev-<n>` with `n` increasing by one per accepted state (commit, proposal acceptance, undo or redo). Clients MUST treat revisions as opaque. `RevisionId` is a string of 1 to 128 characters.

### 9.2 Receipts

A Receipt records one change that produced a new revision. Its fields are defined by the `Receipt` schema: `transactionId` (the request id), `kind` (`commit`, `proposal`, `undo` or `redo`), `projectId`, `baseRevision`, `revision`, `committedAt`, `client`, `operationCount`, `operations`, `changes`, `created`, `removed`, `undoable`, and optionally `label`, `proposalId` and `targetTransactionId`. `created` and `removed` are the last path segments of added and removed entities that carry an id. Undo and redo receipts have no operations.

The host keeps, per session, a log of request records (action, status, error code, diagnostics and, for commits, the receipt). The log holds at most `receiptRetention` records and drops the oldest first.

`receipt.get` returns the record for a request id of the calling session. For a successful commit it includes the `receipt`; for a rejected or failed request it includes `status`, `errorCode` and `diagnostics` and no `receipt`. An id that has no retained record returns `not_found`.

## 10. Diffs and entity paths

### 10.1 Entity kinds

A diff uses these entity kinds: `project`, `tempo`, `meter`, `trackOrder`, `track`, `instrument`, `effectOrder`, `effect`, `clip`, `note`, `midiEvents`, `automationLane`, `section`, `asset`.

### 10.2 Paths

An entity path is a slash-separated path into the project. The paths the reference host emits are:

| Entity         | Path                                    |
| -------------- | --------------------------------------- |
| project        | `/project`                              |
| tempo          | `/tempo`                                |
| meter          | `/meter`                                |
| trackOrder     | `/trackOrder`                           |
| track          | `/tracks/<trackId>`                     |
| instrument     | `/tracks/<trackId>/instrument`          |
| effectOrder    | `/tracks/<trackId>/effectOrder`         |
| effect         | `/tracks/<trackId>/effects/<deviceId>`  |
| clip           | `/tracks/<trackId>/clips/<clipId>`      |
| note           | `<clip path>/notes/<noteId>`            |
| midiEvents     | `<clip path>/midiEvents`                |
| automationLane | `/tracks/<trackId>/automation/<laneId>` |
| section        | `/sections/<sectionId>`                 |
| asset          | `/assets/<assetId>`                     |

Each entity's value excludes its child collections, which are separate entities. `/project` holds the project fields other than `tempo`, `meter`, `tracks`, `sections` and `assets`. `/trackOrder` and `<track path>/effectOrder` hold the ordered id lists. `instrument` exists only when the track has one. `note` and `midiEvents` exist only for MIDI clips; `midiEvents` holds `{controllers, pitchBends}` and exists for every MIDI clip. The order of clips within a track is not an entity.

### 10.3 Diff rules

A diff is a list of changes, each `{entity, path, kind, before?, after?, fields?}` where `kind` is `add`, `remove` or `update`.

- A diff lists all removes, then all adds, then all updates.
- Removes are emitted deepest path first, then in lexicographic path order. Adds are emitted shallowest path first, then in lexicographic path order. Updates are emitted in lexicographic path order.
- An update of an object-valued entity lists the changed top-level fields in `fields`, sorted. An update of an array-valued entity (`tempo`, `meter`, `trackOrder`, `effectOrder`) has no `fields`.
- Values are compared structurally; object keys with undefined values are ignored.
- `invertChanges` reverses the order of the list, turns each add into a remove and each remove into an add, and swaps `before` and `after` of each update. It is used for undo.
- Applying a change list to a state fails with `undo_conflict` if an add targets a path that already exists, or if a remove or update targets a path that is absent or whose current value is not structurally equal to `before`.

## 11. Scope

### 11.1 Scope shape

A scope has any subset of:

- `operations`: names the transaction MAY use. Entries are an exact operation name, a `prefix.*` pattern, or `*`.
- `tracks`: track ids. A change is in scope when its path begins with `/tracks/<id>` for a listed id. Changes to `/project`, `/tempo`, `/meter`, `/trackOrder`, `/sections/...` and `/assets/...` are therefore out of scope.
- `clips`: clip ids. A change is in scope when its path is `/tracks/<trackId>/clips/<id>` or a descendant of it, for a listed id.
- `timeRange`: `{start, end, unit}` with `unit` one of `beats`, `seconds` or `samples`. Every changed time-bearing entity must lie inside the range, measured in seconds, both before and after the change. The range is converted to seconds with the tempo (and sample rate) of the state on each side. A `samples` range on a project without `sampleRate` is a violation.
- `properties`: field names for updates and collection names for add and remove.

Each of `tracks`, `clips`, `operations` and `properties`, when present, MUST be non-empty.

Time-bearing entities are `clip`, `note`, `midiEvents`, `automationLane` and `section`. A change to any other entity kind is a violation under `timeRange`. The extent of a `note` is its position on the timeline (clip start plus note start minus clip `offset`). The extent of a `midiEvents` or `automationLane` change is the span of the events or points that were added, removed or changed. A `clip` change that updates `start`, `offset` or `timebase` of a MIDI clip also re-places its notes and events, so the mapped extents of every note and of the clip's events, before and after, are part of that change. A time-bearing change with no such extent is a violation.

### 11.2 Evaluation

The session scope and the transaction scope are each evaluated against the actual diff, independently. A change is accepted only if it passes both. The effective scope is the intersection `transaction.commit`, `transaction.validate` and `proposal.create` evaluate the session scope and the transaction scope. `proposal.accept` evaluates the session scope, the proposal's scope and the scope stored from the proposer. `history.undo` and `history.redo` evaluate the session scope only and return `scope_violation` on failure.

Each violation of one change is reported in one diagnostic whose path is the change path; multiple reasons are joined with `; `.

Operation-name violations carry the operation index and no path.

### 11.3 Properties

Collection names checked against `properties` are: `project`, `tempo`, `meter`, `trackOrder`, `tracks`, `instrument`, `effectOrder`, `effects`, `clips`, `notes`, `midiEvents`, `automation`, `sections`, `assets`.

## 12. Proposals

A proposal is a stored transaction with its base revision, its diff and its status. Statuses are `open`, `accepted`, `rejected` and `stale`.

- `proposal.create` validates and evaluates the transaction like `transaction.commit` but assigns no revision. It stores the proposal as `open`, together with the proposed state and the proposer's scope. A duplicate `proposalId` returns `precondition_failed`. It counts toward `maxOpenProposals`; creating beyond the limit returns `limit_exceeded`.
- `proposal.list` takes an optional `status` array and returns `{proposals}`. `proposal.get` returns `{proposal, state?}`; the proposed state is included only when `includeState` is true.
- `proposal.accept` requires a current `baseRevision` like any write. If the proposal's base revision equals the current revision, the stored proposed state is used and the invariant set is not run again. If not, the proposal's changes are re-applied to the current state and the invariant set runs. If re-application or the invariant set fails, the proposal becomes `stale` and the result is `proposal_stale`. Scope is then evaluated (section 11.2) and the commit is recorded with kind `proposal`.
- `proposal.accept` on a proposal that is `stale` returns `proposal_stale`, and on one that is `accepted` or `rejected` returns `proposal_closed`.
- `proposal.reject` changes an `open` or `stale` proposal to `rejected`. It returns `proposal_closed` for an `accepted` or `rejected` proposal.

## 13. History

History records committed and accepted changes, and undo and redo entries. Entry kinds are `commit`, `proposal`, `undo` and `redo`.

- `history.undo` applies the inverse of the newest entry that is not an `undo` entry and has not already been undone, using `invertChanges`. With no such entry it returns `nothing_to_undo`. With an explicit `transactionId`, it undoes that entry: an unknown id returns `not_found`; an `undo` entry, or an entry that is not undoable or is already undone, returns `precondition_failed`. Request ids are unique only per session, so the id is resolved to the caller's own entry when there is one; otherwise, if entries from several sessions share the id, the result is `precondition_failed`.
- `history.redo` re-applies the most recently undone entry. The host scans the history from the newest entry backward, skipping `redo` entries. A `commit` or `proposal` entry ends the scan with no target, and the first `undo` entry not yet redone is the target. With no target, or when the target's original entry is no longer in the history, it returns `nothing_to_redo`.
- If the inverse does not apply, or the invariant set fails afterwards, the result is `undo_conflict`. Scope is checked as described in section 11.2.
- Receipts of undo and redo carry `undoable: true`.
- `history.list` returns the last `limit` entries and `canUndo`, `canRedo`.

## 14. Assets

Assets are the host's logical media. The host stores descriptors and bytes; the project records only references (`assets` array). See `AUDIO-DOMAIN.md` section 8.

- `asset.list` returns project assets, or with `store: true`, the host store.
- `asset.import` reads a file from a configured import root. `root` defaults to `inbox`. Checks run in this order:
  1. unknown root: `path_rejected`,
  2. path empty, containing NUL or a backslash, absolute, with a drive letter, with an empty, `.` or `..` segment, escaping the root, or with a root that does not exist: `path_rejected`,
  3. media type (from `mediaType`, else the file extension) not in the importable set `audio/wav`, `audio/flac`, `audio/mpeg`, `audio/ogg`, `audio/aiff`, `audio/midi`: `invalid_params`,
  4. not a regular file: `path_rejected`; file does not exist: `asset_not_found`,
  5. size above the host's `maxAssetBytes` (default 64 MiB): `limit_exceeded`,
  6. explicit `assetId` already in the store: `precondition_failed`.
- Messages replace the root's filesystem path with `<root>`.
- `asset.import` does not require `baseRevision` and does not change project state. A client links the imported asset with the `asset.link` operation.
- A response MUST NOT contain a host filesystem path.

## 15. Jobs

Jobs run renders and generations asynchronously. A job does not change project state. It returns output that a client may submit as a transaction or proposal.

- Kinds: `render`, `generation`. States: `queued`, `running`, `succeeded`, `failed`, `cancelled`.
- `render.request` without an executor returns `capability_unsupported`. It MAY name a `proposalId`; the job then uses the proposal's proposed state with the current revision (`not_found`, `proposal_closed` or `proposal_stale` if the proposal is unknown, closed or stale). An unknown entry in `trackIds` returns `not_found`; problems reported by the executor's validation return `invalid_params`.
- `generation.request` has no proposal input. It snapshots the accepted current state. An unknown generator returns `not_found`.
- `job.status` and `job.cancel` return `{job}`.
- `job.cancel` moves a `queued` or `running` job to `cancelled` and aborts it. A job in a terminal state returns `job_not_cancellable`. An unknown id returns `not_found`.
- A job that fails with a domain error carries that error code, with the message `job executor failed (<code>)`; the executor's own message is not passed on because it may contain host paths. Any other failure is `internal_error` with the message `job executor failed`.
- Cancellation is terminal immediately. The host does not wait for an executor that ignores the abort signal; its later output is discarded.
- Executors are registered by the embedding application. A host MUST NOT run code supplied by a project.
- The reference executors (`packages/host/src/engine/fixture-executors.ts`) are test doubles. They produce a manifest and a deterministic pattern. They are not render engines and not composition models.
- A job result carries `assets`, optional `operations` that a client may submit, and an optional `reproducibility` record.

## 16. Capabilities and version negotiation

### 16.1 Capability names

`aep.core`, `aep.proposals`, `aep.history`, `aep.audio.assets`, `aep.audio.assets.import`, `aep.render`, `aep.generation`, `aep.jobs`, `aep.audio.project`, `aep.audio.tracks`, `aep.audio.clips`, `aep.audio.midi`, `aep.audio.tempo`, `aep.audio.sections`, `aep.audio.routing`, `aep.audio.devices`, `aep.audio.automation`.

Each operation requires one capability (`AUDIO-DOMAIN.md` section 6). Each action requires one capability (section 7.1).

### 16.2 Advertisement

`aep.capabilities` returns the advertised capabilities, the action version and the host's limits. It also reports the negotiated `protocolVersion`, the `operations` the host accepts (filtered by the advertised capabilities), and options for `aep.render` (available renderers) and for import (`roots`, `maxBytes`). The reference host always reports `deviceTypes: []`.

The advertised set is the host's configured capabilities when given, otherwise a default set. The default set is every capability named in sections 7.1 and `AUDIO-DOMAIN.md` section 6, except: `aep.render` when no render executor is configured, `aep.generation` when no generation executor is configured, `aep.jobs` when no executor of either kind is configured, and `aep.audio.assets.import` when no import root is configured. `aep.core` is always advertised.

### 16.3 Version

Each action has a version. AEP v0.1 defines version 1 for every action. A request with any other version is `unsupported_version`. A host that supports several versions of an action MUST advertise each of them in the manifest.

Protocol versions have the form `MAJOR.MINOR`; the reference host supports `0.1`. Two versions are compatible when their majors are equal and, for major 0, their minors are equal. `aep.capabilities` accepts an optional `params.versions` (array of strings) listing the versions the client supports. The host selects the highest compatible version, reports it as `protocolVersion`, and returns `unsupported_version` when there is none. Without `versions`, the host reports its own current version.

## 17. Limits

| Limit                         | Default (reference) | Enforced                                                    |
| ----------------------------- | ------------------- | ----------------------------------------------------------- |
| `maxOperationsPerTransaction` | 1000                | before any operation is applied                             |
| `maxRequestBytes`             | 1,048,576           | after action checks, before the ledger                      |
| `maxNotesPerClip`             | 100,000             | when operations add notes, and as an invariant              |
| `maxTracks`                   | 512                 | when operations add tracks, and as an invariant             |
| `maxOpenProposals`            | 64                  | at `proposal.create`                                        |
| `receiptRetention`            | 1000                | default retention of the ledger and receipt log per session |

Notes:

1. The reference test fixtures use smaller values. They are not normative.
2. `maxAssetBytes` is a host option (default 64 MiB), not a field of the limits object.
3. The 4 MiB caps of the directory and stdio bindings are transport constants. They are not derived from `maxRequestBytes`.
4. `receiptRetention` bounds retention, not receipt size.

Limits are advertised in `aep.capabilities`. A host MUST NOT accept a request that exceeds a limit, and MUST return `limit_exceeded` for it.

## 18. Error codes

The 27 codes, with the `next` and `status` each code carries (`packages/schema/src/errors.ts`). Every code's `next` is a member of the Core enum `none`, `fix`, `reread`, `ask_user`, `reconcile`.

| Code                     | next      | status        | Meaning                                                                      |
| ------------------------ | --------- | ------------- | ---------------------------------------------------------------------------- |
| `bad_request`            | fix       | rejected      | Envelope failed validation.                                                  |
| `unsupported_version`    | fix       | rejected      | Version is not supported for the action.                                     |
| `not_authorized`         | ask_user  | rejected      | Credential mismatch, role or action not permitted, or workspace mismatch.    |
| `session_expired`        | ask_user  | rejected      | Session has expired.                                                         |
| `session_revoked`        | ask_user  | rejected      | Session has been revoked.                                                    |
| `unknown_action`         | fix       | rejected      | Action is not defined.                                                       |
| `id_conflict`            | fix       | rejected      | Request id reused with a different request.                                  |
| `invalid_params`         | fix       | rejected      | Parameters or an operation payload failed validation.                        |
| `limit_exceeded`         | fix       | rejected      | A configured limit was exceeded.                                             |
| `conflict`               | reread    | rejected      | `baseRevision` does not equal the current revision.                          |
| `not_found`              | reread    | rejected      | A referenced entity does not exist.                                          |
| `precondition_failed`    | fix       | rejected      | An operation's precondition does not hold.                                   |
| `validation_failed`      | fix       | rejected      | Resulting state failed schema or invariant validation.                       |
| `capability_unsupported` | fix       | rejected      | Required capability is not advertised.                                       |
| `scope_violation`        | ask_user  | rejected      | A change lies outside the scope.                                             |
| `proposal_stale`         | reread    | rejected      | Proposal base changed and re-application failed.                             |
| `proposal_closed`        | reread    | rejected      | Proposal is already accepted or rejected.                                    |
| `undo_conflict`          | reread    | rejected      | Inverse changes do not apply to the current state.                           |
| `nothing_to_undo`        | none      | rejected      | No undoable entry exists.                                                    |
| `nothing_to_redo`        | none      | rejected      | No redoable entry exists.                                                    |
| `asset_not_found`        | fix       | rejected      | Asset is not in the store or the file does not exist.                        |
| `asset_unavailable`      | reread    | rejected      | Asset exists but is not available.                                           |
| `path_rejected`          | fix       | rejected      | Import path is outside the root, not a regular file, or the root is unknown. |
| `job_not_cancellable`    | none      | rejected      | Job is already in a terminal state.                                          |
| `busy`                   | reread    | rejected      | Request with this id is still being processed.                               |
| `internal_error`         | none      | failed        | Unexpected host failure.                                                     |
| `outcome_uncertain`      | reconcile | indeterminate | Outcome cannot be determined; the client MUST reconcile (section 6.4).       |

The error `message` is a human-readable string. Clients MUST branch on `code` and `next`, not on `message`.

## 19. Extensions

Entities that carry an `extensions` object accept keys that match `^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$` with any JSON value. Other properties of those entities are closed.

Extension keys SHOULD be reverse-DNS names owned by the publisher (for example `com.example.reverb`). The `aep.` prefix is reserved for AEP. The reserved prefix is a convention in v0.1 and is not enforced by the schema (see `docs/adr/0005-extension-architecture.md`).

A host MUST preserve extension values on round trip, and MUST NOT interpret them. A host MUST NOT include extension values in diagnostics beyond their paths.

## 20. Conformance

A conforming host implements sections 4 to 18 and the operations in `AUDIO-DOMAIN.md` without extension. A conforming host MUST:

- pass the envelope and vocabulary checks in `tests/mep-core-compat.test.ts`,
- pass the AEP conformance suite, reached through the `conformance` script in the root `package.json`,
- publish schemas matching `schemas/`.

The conformance script runs the reference host at `examples/minimal-host`. Its outputs are not themselves normative.

## 21. Open items

1. The reference ledger, receipt log, history and job manager are in memory and are lost on restart. MEP Core 1 expects a reservation to be durable before an effect; AEP v0.1 does not claim that durability and does not yet define what a durable host MUST persist.
2. The unit of `loop.length` is not defined by the schema.
