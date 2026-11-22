# AEP v0.1 — implementation design (normative for the reference SDK)

This is the working design that the packages implement. `specs/` restates it normatively for
third-party implementers. When the two disagree, fix one; do not let them drift.

## 0. Layering and packages

| Package          | Role                                                                                                                                                                         | Depends on                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `@aep/schema`    | Zod schemas, TS types, JSON Schema export, time conversions. **The contract.**                                                                                               | zod                             |
| `@aep/core`      | Domain-independent utilities: errors, canonical JSON, version negotiation, request ledger (idempotency), entity diff/apply/invert, safe path resolution, credential helpers. | schema                          |
| `@aep/host`      | Host SDK + in-memory reference host: audio-domain operation appliers, invariants, scope checks, sessions, transactions, proposals, history, assets, jobs.                    | schema, core                    |
| `@aep/transport` | Bindings that move MEP Core 1 documents: directory (MEP Core local binding), stdio (NDJSON), in-memory. Host side and client side.                                           | schema, core                    |
| `@aep/client`    | Typed client SDK over any client transport.                                                                                                                                  | schema, core, transport         |
| `@aep/testing`   | Conformance suite (runs against any host through a transport) + CLI.                                                                                                         | schema, core, client, transport |

No package may depend on an audio renderer, DSP, UI, or AI provider.

## 1. Wire: AEP is a MEP Core 1 domain profile

Every document on the wire validates against MEP Core 1 (`mep/core/1`) `core.schema.json`:
request `{protocol, session, workspace, id, credential, action, version, baseRevision?, params}`;
result `{protocol, session, workspace, id, status, revision?, output?, error?}`.

- `workspace` = AEP project id. One session ↔ one project.
- `action` = AEP action name (see `ACTIONS` in `packages/schema/src/actions.ts`), `version` = 1 for all v0.1 actions.
- Request `id` = transaction id = idempotency key. Dedupe by `(session, id)`; same id + same
  fingerprint (canonical JSON of the request without `credential`) returns the stored result
  **verbatim**; same id + different fingerprint → `id_conflict`.
- `status`: `succeeded` (with `revision` = project revision after the action, and `output`),
  `rejected` (nothing happened), `failed` (started, provably no durable effect),
  `indeterminate` (`next: reconcile`).
- Rejected results carry only `{code, next, message}` (Core forbids extra error fields).
  **Structured diagnostics** for any request are available through the read action
  `receipt.get {requestId}`; hosts MUST retain them with the receipt.
- All write actions require `baseRevision`, except those in `NO_BASE_REVISION_ACTIONS`.
  `baseRevision` must equal the current accepted revision **at commit time**, else `conflict`
  (`next: reread`). `revision` on a rejected/failed result SHOULD be the current revision.
- Read actions MAY carry `baseRevision`; if present and stale, hosts still answer (reads are not
  conditional) — clients compare `revision` in the result.

### Validation order (host, per request)

1. Parse the envelope against `CoreRequest` → `bad_request`.
2. Session: unknown session or wrong credential (constant-time compare) → `not_authorized`;
   expired → `session_expired`; revoked → `session_revoked`; workspace ≠ session project → `not_authorized`.
3. Action: not in `ACTIONS` → `unknown_action`; `version` ≠ 1 → `unsupported_version`;
   capability not declared by the host → `capability_unsupported`; not permitted for the session
   role/grants → `not_authorized`.
4. Size: serialized request > `limits.maxRequestBytes` → `limit_exceeded`.
5. Ledger `begin` (replay / pending→`busy` / conflict→`id_conflict`). Steps 1–4 failures are NOT
   recorded in the ledger (no identity reserved for unauthenticated or malformed input).
6. Params against the action schema → `invalid_params` (diagnostics with JSON paths).
7. Write actions: `baseRevision` missing → `invalid_params`; stale → `conflict`.
8. Execute. Unexpected exceptions → `internal_error` (`failed`) only if state is untouched
   (always true in the reference host since commits are a single reference swap).
9. Store result + diagnostics in the ledger, return.

## 2. State model

- Accepted state: an immutable `Project` value + revision id. Commits replace it atomically.
- Revision ids: opaque strings. Reference host: `rev-<n>` (n increments per commit, per project).
  Clients MUST NOT parse them.
- Proposed state: lives only inside a proposal. Never visible via `project.inspect`.
- Artifacts (render outputs, generated assets): live in the host asset store, outside project
  state until linked with `asset.link`.

## 3. Entity paths and diffs

The project is flattened into an `EntityMap` (path → `{entity, value}`); `value` excludes child
collections. Paths are id-based, never index-based:

| Path                                    | entity         | value                                             |
| --------------------------------------- | -------------- | ------------------------------------------------- |
| `/project`                              | project        | `{id,name,metadata,sampleRate?,extensions?}`      |
| `/tempo`                                | tempo          | the full tempo array                              |
| `/meter`                                | meter          | the full meter array                              |
| `/trackOrder`                           | trackOrder     | array of track ids, top-to-bottom                 |
| `/tracks/{tid}`                         | track          | track minus `clips,effects,automation,instrument` |
| `/tracks/{tid}/instrument`              | instrument     | device (absent when `instrument` is null)         |
| `/tracks/{tid}/effectOrder`             | effectOrder    | array of effect device ids                        |
| `/tracks/{tid}/effects/{did}`           | effect         | device                                            |
| `/tracks/{tid}/clips/{cid}`             | clip           | clip minus `notes,controllers,pitchBends`         |
| `/tracks/{tid}/clips/{cid}/notes/{nid}` | note           | note                                              |
| `/tracks/{tid}/clips/{cid}/midiEvents`  | midiEvents     | `{controllers, pitchBends}` (MIDI clips only)     |
| `/tracks/{tid}/automation/{lid}`        | automationLane | lane (points included)                            |
| `/sections/{sid}`                       | section        | section                                           |
| `/assets/{aid}`                         | asset          | asset                                             |

`flattenProject`/`unflattenProject` are exact inverses (`unflatten(flatten(p))` deep-equals the
parsed `p`, with clips ordered by `(start, id)`, notes by `(start, pitch, id)`, sections by
`(start, id)`, assets by `id`). Moving a clip to another track = remove + add under the new path.

Receipts, `transaction.validate`, proposals and history all report `Change[]` from
`diffEntities(flatten(before), flatten(after))`. Created/removed id lists = last path segment of
add/remove changes (ids of entities that have one).

## 4. Operations

Pure: `applyOperation(project, op, ctx) → project`. A transaction applies its operations in order
to a working copy; any error aborts the whole transaction (nothing committed). After all
operations, `validateInvariants(project)` must return no errors, then scope is checked on the diff.

Preconditions (error codes): referenced entity missing → `not_found`; id already exists anywhere
in its id space → `precondition_failed`; op not valid for the target (e.g. notes on an audio clip,
`sourceOffset` on a MIDI clip, trim past the other edge) → `precondition_failed`; capability not
advertised → `capability_unsupported`; limits → `limit_exceeded`.

Id spaces (unique project-wide per kind): tracks, clips, devices (instruments+effects), automation
lanes, sections, assets. Note ids are unique per clip.

Key semantics:

- `track.add` with `index` inserts into order; nested `clips/effects/instrument/automation` in the
  payload are allowed. `track.remove` removes the track with its clips, devices and lanes; fails `precondition_failed` if another
  track's `output`/`sends`/`parentId` references it.
- `track.reorder {trackId,index}`: move to index (clamped to last).
- `clip.move`: `start` and/or `trackId`. Target track must accept the clip type
  (`audio` clips → `audio|hybrid` tracks; `midi` → `midi|instrument|hybrid`). Same rule for `clip.insert`.
- `clip.trim edge=start to=T` (T < end): Δ = T − start; start = T; duration −= Δ; MIDI `offset += Δ`;
  audio `sourceOffset += (sec(T) − sec(oldStart)) × playbackRate` (clip timebase via tempo map).
  T may be < start (extend left) as long as resulting offset/sourceOffset ≥ 0, else `precondition_failed`.
  `edge=end`: duration = T − start (> 0).
- `clip.split at=T` (start < T < end): left keeps id, duration = T − start. Right gets `newClipId`,
  start = T, duration = oldEnd − T, offset/sourceOffset advanced as for trim-start. MIDI notes are
  partitioned by source position relative to the split source point S = offset + (T − start):
  notes with `start < S` stay left (and are NOT shortened — the clip window cuts them),
  notes with `start ≥ S` move right. Controllers/pitchBends are copied to both. Fades: left keeps
  fadeIn, right keeps fadeOut.
- `clip.duplicate`: deep copy with new id; notes get `<noteIdPrefix><oldId>` ids; default start =
  source end; default track = source track.
- `midi.notes.update`: patches; note must exist. `midi.notes.add`: new ids unique in clip.
- `tempo.update`/`meter.update` replace the full maps; must be sorted, first at 0, no duplicate
  positions. Stored positions are never rewritten: beats-timebase objects keep their beat
  positions (and so move in absolute time), seconds-timebase objects keep their seconds.
- `effect.update.patch.parameters` merges; `null` deletes a key. `instrument.set null` removes.
- `automation.points.update`: replace points in `[range.start, range.end)` (or all), keep sorted,
  reject duplicate times. Device targets must exist on the same track.
- `asset.link {assetId}`: asset must exist in the host asset store → copy descriptor into
  `project.assets`; else `asset_not_found`. `asset.unlink`: fails `precondition_failed` if any clip
  or device references it.
- `routing.update`: `output`/send targets must be existing `bus` tracks (≠ self); no routing cycles.

Invariants (`validateInvariants`): unique ids per id space; tempo/meter sorted and start at 0;
every clip references an existing project asset (audio) and lives on a compatible track; every
`assetId` on a device exists in `project.assets`; `parentId` exists and creates no cycle;
routing targets valid and acyclic; notes per clip ≤ `limits.maxNotesPerClip`; tracks ≤ `limits.maxTracks`.
Invariant failures reject the transaction with `validation_failed` (diagnostic code
`invariant_violation`); during undo/redo they surface as `undo_conflict`.

## 5. Scope (validated on the actual diff)

Effective scope = session scope ∩ transaction scope (both enforced independently). For every
`Change`:

- `operations`: every op name in the transaction matches a pattern (`*`, `midi.notes.*`, exact).
- `tracks`: change path must start with `/tracks/{tid}` for an allowed tid. Project-level entities
  (`/project`, `/tempo`, `/meter`, `/trackOrder`, `/sections/*`, `/assets/*`) are out of scope.
  Adding a track is in scope only if its id is listed.
- `clips`: change path must be `/tracks/*/clips/{cid}` or below for an allowed cid. Moving a
  clip to another track is a remove+add; both paths carry the clip id, so it is allowed — unless
  `tracks` also forbids the destination.
- `timeRange` (converted to seconds using the project's tempo map, before AND after): every change
  must be time-bearing — clip, note, automationLane (points), midiEvents, section — and its time
  extent (in seconds) both before (if existed) and after (if exists) must lie within
  `[start, end]`. Extents: clip = [start, end] on the timeline; note = timeline extent of the
  note mapped through its clip (timeline start = clip.start + (note.start − offset), not clipped
  to the clip window); automation lane = extent of the changed points only (points whose
  time/value/curve differ); midiEvents = extent of changed events. Any non-time-bearing change
  (track gain, tempo, devices, …) → violation. Tempo changes are therefore always out of scope
  under a `timeRange` (they move everything in absolute time).
- `properties`: for `update`, every name in `fields` must be allowed; for add/remove, the
  collection name must be allowed (`tracks`, `clips`, `notes`, `effects`, `automation`,
  `sections`, `assets`, `instrument`, `midiEvents`, `tempo`, `meter`, `trackOrder`, `effectOrder`).
  `/project` updates use field names; `/tempo` → `tempo`, etc.

Violations → `scope_violation` (`next: ask_user`) with one diagnostic per offending change
(`path` = entity path). Indirect effects are caught because the check runs on the diff, not on op
parameters: e.g. `clip.move` drags its notes' timeline extent; a `track.update` gain change under
a time scope is rejected.

## 6. Sessions and permissions

Sessions are created host-side (out of band — CLI flag, config file, or host UI). A session has:
`id`, `projectId`, `credential` (opaque secret, ≥ 128 bits), `client` name, `role`
(`read` | `propose` | `edit` | `admin`, see `ROLE_ACTIONS`), optional `scope`, optional
`allowedActions` subset, `expiresAt` (ms), `revoked`.

- The session manifest (`CoreManifest`) lists only actions allowed for that session.
- `propose` role = an AI agent that can read, create proposals, and start preview render /
  generation jobs (and cancel them), but cannot commit; a human-side
  `edit` session accepts/rejects.
- Credentials never appear in state, receipts, diagnostics, manifests or logs.

## 7. Proposals

- `proposal.create {transaction, proposalId?}` (requires `baseRevision` = current): apply
  operations to a copy, validate invariants + scope; store `{changes, operations, baseRevision,
proposed state}`. Does NOT change accepted state or revision. Result `revision` = current.
- `proposal.get {includeState}` returns proposal + optional proposed state. `proposal.list`.
- `proposal.accept` (edit role, `baseRevision` = current): if the project revision still equals
  the proposal base → commit proposed state. Otherwise attempt `applyChanges(current, changes)`
  (clean only if every changed entity is unchanged since the base); success → commit with
  `kind: 'proposal'`, else mark proposal `stale` and reject `proposal_stale`. Scope and invariants
  are re-checked on the actual resulting diff at accept time.
- `proposal.reject` closes it (`rejected`). Accepted/rejected proposals → `proposal_closed`
  on accept/reject; a `stale` proposal may still be rejected (to close it) but not accepted.
- At most `limits.maxOpenProposals` open per project.
- `render.request {proposalId}` previews proposed state.

## 8. History, undo, redo

- Every commit (transaction, proposal accept, undo, redo) appends a `HistoryEntry` holding its
  `changes`.
- `history.undo {transactionId?}` (requires `baseRevision`): target = given transaction or the
  most recent entry that is undoable, not already undone, and not itself an undo that has been
  redone. Apply `invertChanges(target.changes)` to the current entity map. If any change no longer
  matches (a later commit modified the same entity) → `undo_conflict` (nothing changes). Success
  commits a new revision (`kind: 'undo'`, `targetTransactionId`), marks target `undoneBy`.
  Undo never rewinds revision ids; it moves forward to a new revision whose content equals the
  pre-target state for the affected entities.
- `history.redo`: re-applies the most recent undo's target changes, only if no non-undo/redo
  commit happened after that undo (linear redo stack) and changes apply cleanly
  (`undo_conflict` otherwise; `nothing_to_redo` if none).
- Nothing to undo → `nothing_to_undo`.
- Undo covers project state only. Render artifacts, imported files and job side effects are not
  undone (documented limitation). Entries are `undoable: false` only if the host cannot invert
  them (never in the reference host).

## 9. Assets

- Host asset store (per host, not per project): `id → Asset + bytes` (reference host: in-memory
  bytes + computed `sha256:` content hash).
- `asset.import {root, path}` (admin role by default): resolves `path` with
  `resolveInsideRoot(importRoots[root], path)`; rejects traversal/absolute/symlink escape
  (`path_rejected`); unknown root → `path_rejected`; missing file → `asset_not_found`; size limit
  → `limit_exceeded`. Registers the asset in the store (no project revision change) and returns it.
- `asset.list {store}`: project assets, or store assets when `store: true`.
- Clients never see host filesystem paths. Large payloads never travel inside JSON.

## 10. Jobs (render / generation)

- Non-transactional, asynchronous. `render.request` / `generation.request` (requires
  `baseRevision`) validates params, snapshots the revision (or proposal), returns `{job}` with
  `state: queued`. `job.status`, `job.cancel` (queued/running → cancelled; terminal →
  `job_not_cancellable`).
- Jobs never mutate project state. Outputs are assets in the host store (`availability: pending`
  until done) and/or `operations` the client can submit.
- Host SDK: pluggable `JobExecutor` per kind. Reference host ships **test fixtures only**:
  `aep.reference.manifest-renderer` produces an `application/vnd.aep.render-manifest+json` asset
  describing what would be rendered (no audio); `aep.reference.pattern` generator returns
  deterministic `midi.notes.add` operations from `{pitches, stepBeats, count}` + `seed`. These
  exist to exercise job lifecycle and are not a renderer or composition model.

## 11. Transports (see TRANSPORT.md)

- **Directory binding (MEP Core 1 local binding)**: host writes `mep.json` (manifest),
  `state.json` (`CoreState` with `data` = project), `results/<id>.json`; client writes
  `requests/<id>.json` via `requests/.<id>.tmp` + `link()` (atomic, fails if the target exists), never overwriting an existing request.
  Host processes requests in arrival order (mtime, then name), publishes results via tmp+rename,
  refreshes `state.json` after each commit. One directory per session. Dir mode 0700, files 0600.
- **Stdio binding**: newline-delimited JSON, UTF-8, one JSON object per line. Client→host lines
  are `CoreRequest`s. Host→client lines are `{"type":"result","result":CoreResult}`, plus
  `{"type":"hello","manifest":CoreManifest}` once at startup. Requests may be pipelined; results
  may arrive out of order and are matched by `id`. Malformed line → host writes a `bad_request`
  result with `id` `"invalid"` if no id could be read. EOF on stdin = shutdown.
- **In-memory**: direct call, for tests and embedding.

All bindings carry the same documents; semantics are transport-independent.
