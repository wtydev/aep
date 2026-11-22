# AEP Audio Domain Specification

Status: AEP 1.0 (normative for implementers). Companion to `specs/core/SPECIFICATION.md` and `specs/core/TRANSPORT.md`.

## 1. Scope and conformance language

This document defines the logical audio project model, its time model, the 31 operations that edit it, the invariants a host checks, and the semantics of assets, routing and automation. It does not define the wire protocol, which is in `specs/core/SPECIFICATION.md`.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in RFC 2119.

The model is an interchange and editing model. It is not a storage format. A host MAY store projects in any internal form that yields the same observable behaviour.

The reference implementation is in `packages/schema/src/` (model, operations, time) and `packages/host/src/domain/` (operation application, invariants, diff, scope). It is informative; where this text and the reference implementation disagree, this text is normative.

## 2. Canonical model

All values are JSON. Every entity has an `id` that matches the Id pattern `^[A-Za-z0-9][A-Za-z0-9._:-]*$` with a maximum length of 128 characters. Ids are unique within their id space (section 7.3). Objects are closed: unknown keys MUST be rejected (`additionalProperties: false`), except inside `extensions`.

### 2.1 Project

| Field        | Type                                                  | Constraints              | Default                                    |
| ------------ | ----------------------------------------------------- | ------------------------ | ------------------------------------------ |
| `id`         | string                                                | `^[A-Za-z0-9_-]{1,100}$` | required                                   |
| `name`       | string                                                | max 256                  | `""`                                       |
| `metadata`   | map of string to string (max 4096), number or boolean | keys max 128             | `{}`                                       |
| `sampleRate` | integer                                               | 8000 to 768000           | absent                                     |
| `tempo`      | array of TempoPoint                                   | min 1                    | `[{beat: 0, bpm: 120, curve: 'step'}]`     |
| `meter`      | array of MeterPoint                                   | min 1                    | `[{bar: 0, numerator: 4, denominator: 4}]` |
| `tracks`     | array of Track                                        |                          | `[]`                                       |
| `sections`   | array of Section                                      |                          | `[]`                                       |
| `assets`     | array of Asset                                        |                          | `[]`                                       |
| `extensions` | Extensions                                            |                          | absent                                     |

`sampleRate` is required only for sample-unit conversions (section 3.4).

### 2.2 Tempo and meter

TempoPoint: `beat` (number, minimum 0), `bpm` (finite number, 1 to 999), `curve` (`step` or `linear`, default `step`). A `step` point holds its tempo until the next point. A `linear` point ramps tempo linearly in beats to the next point's `bpm` (section 3.2). The `curve` of the last point has no effect.

MeterPoint: `bar` (integer, minimum 0, 0-based), `numerator` (integer, 1 to 64), `denominator` (one of 1, 2, 4, 8, 16, 32). A meter point applies from its bar until the next point.

Tempo and meter maps are ordered by position. The first point of each map MUST be at position 0 (beat 0 or bar 0). Positions MUST NOT repeat.

### 2.3 Track

| Field          | Type                    | Constraints                                    | Default  |
| -------------- | ----------------------- | ---------------------------------------------- | -------- |
| `id`           | Id                      |                                                | required |
| `name`         | string                  | max 256                                        | required |
| `kind`         | enum                    | `audio`, `instrument`, `midi`, `bus`, `hybrid` | required |
| `parentId`     | Id or null              | refers to a track                              | `null`   |
| `mute`, `solo` | boolean                 |                                                | `false`  |
| `gainDb`       | number                  | -144 to 24                                     | `0`      |
| `pan`          | number                  | -1 to 1                                        | `0`      |
| `channels`     | integer                 | 1 to 64                                        | `2`      |
| `output`       | `master` or Id          | refers to a bus track when not `master`        | `master` |
| `sends`        | array of Send           |                                                | `[]`     |
| `instrument`   | Device or null          |                                                | `null`   |
| `effects`      | array of Device         | signal order                                   | `[]`     |
| `clips`        | array of Clip           |                                                | `[]`     |
| `automation`   | array of AutomationLane |                                                | `[]`     |
| `extensions`   | Extensions              |                                                | absent   |

Send: `targetTrackId` (Id), `gainDb` (-144 to 24, default 0), `preFader` (boolean, default false).

Tracks are listed top to bottom in `tracks`. That order is the track order.

### 2.4 Clips

Common clip fields: `id`, `name` (max 256, optional), `start` (number, minimum 0), `duration` (number, greater than 0), `timebase` (`beats` or `seconds`, required), `muted` (default false), `gainDb` (-144 to 24, default 0), `fadeIn` and `fadeOut` (Fade or absent), `extensions`.

Fade: `duration` (minimum 0, in clip timebase units), `curve` (`linear`, `equal-power` or `exponential`, default `linear`).

**AudioClip** (`type: "audio"`): adds `assetId` (required, refers to an asset), `sourceOffset` (minimum 0, default 0, source seconds), `playbackRate` (0.01 to 100, default 1), `loop` (absent, or `{enabled: boolean, length: number > 0}`).

Source position for an audio clip is `sourceOffset + clipLocalSeconds * playbackRate` in seconds of the source asset. When `loop.enabled` is true, the loop region is `[sourceOffset, sourceOffset + loop.length)`, in seconds of the source, and the source position wraps within it. For a MIDI clip the loop region is `[offset, offset + loop.length)`, in clip timebase units. `loop.length` is in source units: seconds of source for audio, clip timebase units for MIDI.

**MidiClip** (`type: "midi"`): adds `offset` (minimum 0, default 0, in clip timebase units), `loop` (as above), `notes` (array of Note), `controllers` (array of ControllerEvent), `pitchBends` (array of PitchBendEvent).

Notes and events are stored in source coordinates in the clip timebase. The clip window shows source range `[offset, offset + duration)`. A note at source time `s` appears on the timeline at `clip.start + (s - offset)`.

Note: `id`, `pitch` (0 to 127), `start` (minimum 0, source coordinates), `duration` (greater than 0), `velocity` (1 to 127), `channel` (0 to 15, default 0), `releaseVelocity` (0 to 127, optional).

ControllerEvent: `time` (minimum 0), `controller` (0 to 127), `value` (0 to 127), `channel` (0 to 15, default 0).

PitchBendEvent: `time` (minimum 0), `value` (-8192 to 8191), `channel` (0 to 15, default 0).

Note ids MUST be unique within a clip. Other event lists have no uniqueness rule.

### 2.5 Sections

Section: `id`, `name` (max 256), `start` (minimum 0), `duration` (greater than 0), `timebase` (`beats` default, or `seconds`), `color` (max 32, optional), `extensions`. Sections MAY overlap.

### 2.6 Devices

Device: `id`, `type` (namespaced, matches `^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$`, for example `com.example.reverb`), `name` (max 256, optional), `bypass` (boolean, default false), `parameters` (map of up to 128-character keys to number, string of max 1024 characters, or boolean; default `{}`), `assetId` (optional, refers to an asset), `extensions`.

A track MAY have one instrument (`instrument`) and an ordered list of effects (`effects`). The two share one id space (section 7.3).

AEP does not standardize plugin binaries. Plugin state MUST be carried in `extensions` or in an asset.

### 2.7 Automation

AutomationLane: `id`, `target`, `timebase` (default `beats`), `min` and `max` (finite, optional), `points` (default `[]`), `extensions`.

Target is one of:

- `{kind: "track", parameter: "gainDb" | "pan"}`
- `{kind: "device", deviceId: Id, parameter: string, 1 to 128 characters}`

AutomationPoint: `time` (minimum 0, in lane timebase units), `value` (finite), `curve` (`step`, `linear` or `exponential`, default `linear`). The curve applies from the point to the next point.

Points MUST be strictly increasing by `time`, so no two points share a time value (invariant 12).

### 2.8 Assets

Asset: `id`, `name` (max 256, optional), `mediaType` (matches `^[a-z]+\/[a-z0-9.+-]+$`), `contentHash` (`sha256:` followed by 64 lowercase hex characters, optional), `byteLength` (integer, minimum 0, optional), `durationSeconds` (minimum 0, optional), `sampleRate` (positive integer, optional), `channels` (1 to 64, optional), `availability` (`available`, `missing` or `pending`), `portability` (`portable` or `host-local`, default `host-local`), `provenance` (optional), `extensions`.

Provenance: `generator` (max 256), `generatorVersion` (max 64), `parameters` (object), `seed` (integer), `engine` (map of string to string max 256), `sourceRevision` (RevisionId, see section 9.1 of `SPECIFICATION.md`), `createdAt` (ISO 8601 date-time). All fields are optional.

Assets are described in section 8.

## 3. Time model

### 3.1 Units

| Quantity                                | Unit                     | Notes                                               |
| --------------------------------------- | ------------------------ | --------------------------------------------------- |
| Musical position and length             | beats (quarter notes)    | beat 0 is the project origin                        |
| Tempo                                   | beats per minute (`bpm`) | seconds per beat = 60 / bpm                         |
| Absolute time                           | seconds                  | floating point                                      |
| Sample position                         | samples                  | integer for sample positions; requires `sampleRate` |
| Bar index                               | 0-based integer          | first bar is 0                                      |
| Gain                                    | dB                       | -144 to 24                                          |
| Pan                                     | normalized               | -1 (left) to 1 (right)                              |
| MIDI pitch, velocity, controller, value | integer                  | 0 to 127; velocity 1 to 127                         |
| Pitch bend                              | integer                  | -8192 to 8191                                       |

### 3.2 Beat to second conversion

Tempo points are sorted by `beat`. Each point starts a segment that runs to the next point. The last segment has no end and is constant.

- A `step` segment has constant tempo `T`. Its seconds for a span of `Δbeats` are `Δbeats × 60 / T`.
- A `linear` segment runs from `(b0, T0)` to `(b1, T1)`, where `T1` is the next point's `bpm`. Its tempo ramps linearly in beats. With `k = (T1 − T0) / (b1 − b0)` and `k ≠ 0`, the tempo at beat `b` is `T(b) = T0 + k (b − b0)`. The seconds from `b0` to `b` are `seconds(b) = 60 / k × log1p(k (b − b0) / T0)`, which equals `60 / k × ln(T(b) / T0)`. The beats from `b0` after `s` seconds are `beats(s) = b0 + T0 × expm1(k s / 60) / k`, which equals `b0 + T0 × (exp(k s / 60) − 1) / k`. The `log1p`/`expm1` forms keep full precision when a ramp is nearly flat. A linear segment with `T1 = T0` is constant.

`beatsToSeconds` sums the seconds of each segment up to the given beat. `secondsToBeats` is its inverse. Implementations MUST use these formulas, with IEEE-754 double arithmetic and `Math.log1p` and `Math.expm1`, so that independent hosts agree to within floating-point rounding. The reference implementation is `packages/schema/src/time.ts`.

### 3.3 Clip and section timebases

A clip or section with `timebase: "beats"` has `start` and `duration` in beats. With `timebase: "seconds"` they are in seconds and are not affected by tempo.

To obtain timeline seconds, a host MUST convert `start` and `start + duration` through the tempo map when the timebase is `beats`.

Positions stored in beats are NOT re-anchored when the tempo map changes. A `tempo.update` changes the seconds of every beat-timebase entity; the beat positions are unchanged. Seconds-timebase entities keep their seconds.

### 3.4 Sample conversion

`secondsToSamples(s, sampleRate)` is `round(s * sampleRate)` with halves rounded away from zero. `samplesToSeconds(n, sampleRate)` is `n / sampleRate`.

A unit of `samples` requires `sampleRate`. A conversion that needs a sample rate when none is present is an error. The reference implementation throws `RangeError`. Where that error reaches a scope check on `timeRange`, it is reported as a `scope_violation` diagnostic.

### 3.5 Bars and meter

The length of a bar is `barLengthBeats = numerator * 4 / denominator`. The meter in force at bar `n` is the last meter point with `bar <= n`.

A host MUST NOT infer bar boundaries from anything other than the meter map. This specification defines no bar-to-beat mapping API beyond this rule.

## 4. Track kinds and clip compatibility

| Track kind   | Audio clip | MIDI clip |
| ------------ | ---------- | --------- |
| `audio`      | accepted   | rejected  |
| `hybrid`     | accepted   | accepted  |
| `midi`       | rejected   | accepted  |
| `instrument` | rejected   | accepted  |
| `bus`        | rejected   | rejected  |

A bus track holds no clips. A rejected combination is `precondition_failed` at the operation that introduces the clip or moves it. It is also an invariant violation (section 7.1).

## 5. Routing

Each track has one `output` (`master` or a bus track id) and zero or more `sends` (each with a bus target).

The routing graph has an edge from a track to its `output` (unless `master`) and to each send target. The graph MUST be acyclic.

A routing target MUST:

- exist,
- differ from the routing track,
- have `kind: "bus"`.

These rules are enforced by `routing.update` and re-checked as invariants at commit (section 7.1).

Send gain and pre-fader state are data. AEP 1.0 defines no mixing semantics beyond what the host advertises.

## 6. Operations

### 6.1 Common rules

Every operation MUST be applied as follows, in this order:

1. If the operation's capability (section 16.1 of `SPECIFICATION.md`) is not advertised, fail with `capability_unsupported`.
2. Apply the operation to a copy of the project state.
3. Validate the resulting state against the `Project` schema. Failure is `validation_failed`, with one diagnostic per issue (at most 8), path `/<issue path>`.

Within an operation, the checks below run in the order listed. The first failing check determines the error.

A list of operations is applied in order. The first failure aborts the list, and the error carries `operationIndex` and, when known, the path of the operation's primary entity. An error that is not a domain error is `internal_error`.

Operation shapes, including patches (which are strict objects), are validated before execution (`SPECIFICATION.md` section 5) and fail with `invalid_params`. Embedded entities (`track`, `clip`, `note`, `device`, `lane`, `section`, tempo and meter points) are parsed again by the operation and fail with `invalid_params`. Patch values that are not re-parsed are checked by step 3. Any operation can therefore also fail with `validation_failed`. A reference to an asset that is not in `assets` (clip, device) is `not_found`.

### 6.2 Operation table

Parameter names are the field names of the operation schema (`packages/schema/src/operations.ts`). Optional parameters are marked `?`.

**Project**

| Operation        | Parameters                                                             | Checks and effects (in order)                                                                                                                    | Errors                                |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| `project.update` | `patch` (ProjectPatch: `name`, `metadata`, `sampleRate`, `extensions`) | Parse patch. Assign each defined field. `metadata`, when present, replaces the whole map. No rescaling of time occurs when `sampleRate` changes. | `invalid_params`, `validation_failed` |

**Tracks**

| Operation       | Parameters                                                                                                 | Checks and effects (in order)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Errors                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `track.add`     | `track`, `index?`                                                                                          | Parse track. If the track count is at `maxTracks`, fail with `limit_exceeded`. Track id must be unused. Then, for each clip in order: clip id unused project-wide and unique within the payload, compatibility with the track kind, note id uniqueness, `maxNotesPerClip` (`limit_exceeded`), and that an audio clip's asset exists in `assets` (`not_found`). Then, for the instrument and each effect: device id unused project-wide and unique within the payload, and its asset exists (`not_found`). Then, for each automation lane: lane id unused project-wide and unique within the payload. Insert at `min(index ?? length, length)`. Parent, output, send and lane target references are not checked here. | `invalid_params`, `limit_exceeded`, `precondition_failed`, `not_found` |
| `track.update`  | `trackId`, `patch` (`name`, `kind`, `parentId`, `mute`, `solo`, `gainDb`, `pan`, `channels`, `extensions`) | Track must exist (`not_found`). Parse patch. If `parentId` is non-null: it MUST NOT equal the track's own id (`precondition_failed`), and it MUST exist (`not_found`). Assign defined fields. A change of `kind` is not checked here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `not_found`, `invalid_params`, `precondition_failed`                   |
| `track.remove`  | `trackId`                                                                                                  | Track must exist. Fail if any other track has this track as `output`, as `parentId`, or as a send target. Remove the track with its clips and automation. Descendants are not removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `not_found`, `precondition_failed`                                     |
| `track.reorder` | `trackId`, `index`                                                                                         | Track must exist. Remove, then insert at `min(index, remaining length)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `not_found`                                                            |

**Clips**

| Operation        | Parameters                                                                                                                                     | Checks and effects (in order)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Errors                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `clip.insert`    | `trackId`, `clip`                                                                                                                              | Track must exist. Parse clip. Clip id unused project-wide. Compatibility with the track kind (section 4). Note ids unique in the clip. Notes not above `maxNotesPerClip`. Audio clip asset exists. Append to the track's clip list (order is not sorted at insertion).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `not_found`, `invalid_params`, `precondition_failed`, `limit_exceeded` |
| `clip.update`    | `clipId`, `patch` (`name`, `duration`, `muted`, `gainDb`, `fadeIn`, `fadeOut`, `sourceOffset`, `playbackRate`, `offset`, `loop`, `extensions`) | Clip must exist. Parse patch. `sourceOffset` and `playbackRate` are rejected on MIDI clips. `offset` is rejected on audio clips. `fadeIn`, `fadeOut` and `loop` accept `null`, which deletes the key. Clip `start` and `timebase` are not patchable here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `not_found`, `invalid_params`, `precondition_failed`                   |
| `clip.remove`    | `clipId`                                                                                                                                       | Clip must exist. Remove it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `not_found`                                                            |
| `clip.move`      | `clipId`, `trackId?`, `start?`                                                                                                                 | Clip must exist. Target track is `trackId` if given, otherwise its current track; it must exist. Check compatibility with the target. Set `start` if given. If the track changed, remove from the source and append to the target.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `not_found`, `precondition_failed`                                     |
| `clip.trim`      | `clipId`, `edge` (`start` or `end`), `to`                                                                                                      | Clip must exist. For `start`: fail if `to >= end`. The delta is `to - start`. Audio: `sourceOffset += (seconds(to) - seconds(start)) * playbackRate`; fail if the result is below 0. MIDI: `offset += delta`; fail if below 0. Then set `start = to` and `duration -= delta`. For `end`: fail if `to <= start`; set `duration = to - start`. Source bounds are checked at commit by invariant 15 (section 7.1).                                                                                                                                                                                                                                                                                                                                                                                                 | `not_found`, `precondition_failed`                                     |
| `clip.split`     | `clipId`, `at`, `newClipId`                                                                                                                    | Clip must exist. `newClipId` must be unused (checked before the position). `at` must satisfy `start < at < end`. The right clip is a copy with `id = newClipId`, `start = at`, `duration = end - at`; `fadeIn` is removed from the right clip, `fadeOut` is removed from the left clip; left `duration = at - start`. The right clip also copies controllers and pitch bends unchanged; both clips keep the full lists. Audio: right `sourceOffset = sourceOffset + (seconds(at) - seconds(start)) * playbackRate`. MIDI: `splitSource = offset + (at - start)`; right `offset = splitSource`; notes with `start >= splitSource` move to the right clip unchanged in source coordinates; notes with `start < splitSource` stay on the left. Notes are not truncated. The right clip is inserted after the left. | `not_found`, `precondition_failed`                                     |
| `clip.duplicate` | `clipId`, `newClipId`, `trackId?`, `start?`, `noteIdPrefix?`                                                                                   | Clip must exist. `newClipId` unused. Target track: `trackId` or the source track; must exist. Compatibility with the target. The copy's `start` is `start` if given, otherwise the source end. MIDI: each note id becomes `<prefix><old id>`, where the default prefix is `<newClipId>-`. The copy is appended to the target.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `not_found`, `precondition_failed`                                     |

**MIDI**

All MIDI operations require a MIDI clip. An audio clip yields `precondition_failed`.

| Operation            | Parameters                                   | Checks and effects (in order)                                                                                                                                                                                                                                                                           | Errors                                                                 |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `midi.notes.add`     | `clipId`, `notes`                            | Clip must exist and be MIDI. Parse each note (`invalid_params`, with the index). Each new id MUST NOT equal an existing note id in the clip. Each new id MUST be unique within the batch. A duplicate fails with `precondition_failed`. Total notes must not exceed `maxNotesPerClip`. Append in order. | `not_found`, `invalid_params`, `precondition_failed`, `limit_exceeded` |
| `midi.notes.update`  | `clipId`, `updates` (each `{noteId, patch}`) | Clip must exist and be MIDI. Process updates in order. Each `noteId` must exist. Assign patch fields (`pitch`, `start`, `duration`, `velocity`, `channel`, `releaseVelocity`). Note ids cannot change.                                                                                                  | `not_found`, `precondition_failed`                                     |
| `midi.notes.remove`  | `clipId`, `noteIds`                          | Clip must exist and be MIDI. Each id must exist (checked in list order). Remove them.                                                                                                                                                                                                                   | `not_found`, `precondition_failed`                                     |
| `midi.events.update` | `clipId`, `controllers?`, `pitchBends?`      | Clip must exist and be MIDI. If `controllers` is given, replace the whole list after parsing each entry. If `pitchBends` is given, replace the whole list likewise. Event times are not checked against the clip window.                                                                                | `not_found`, `invalid_params`, `precondition_failed`                   |

**Tempo, meter and sections**

| Operation        | Parameters                                                  | Checks and effects (in order)                                                                                                                                                                                                                                          | Errors                                  |
| ---------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `tempo.update`   | `tempo` (array of TempoPoint)                               | The array MUST contain at least one point (`invalid_params`). Parse each point. The first `beat` must be 0. Then, for each consecutive pair, a repeated beat fails, then a decreasing beat fails. Replace the map. Beat positions of existing content are not changed. | `invalid_params`, `precondition_failed` |
| `meter.update`   | `meter` (array of MeterPoint)                               | As `tempo.update`, with `bar` in place of `beat`. The first `bar` must be 0.                                                                                                                                                                                           | `invalid_params`, `precondition_failed` |
| `section.add`    | `section`                                                   | Parse section. Section id unused. Append.                                                                                                                                                                                                                              | `invalid_params`, `precondition_failed` |
| `section.update` | `sectionId`, `patch` (`name`, `start`, `duration`, `color`) | Section must exist. Parse patch. Assign fields.                                                                                                                                                                                                                        | `not_found`, `invalid_params`           |
| `section.remove` | `sectionId`                                                 | Section must exist. Remove.                                                                                                                                                                                                                                            | `not_found`                             |

**Routing**

| Operation        | Parameters                     | Checks and effects (in order)                                                                                                                                                                                                                                                                                                                                  | Errors                             |
| ---------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `routing.update` | `trackId`, `output?`, `sends?` | Track must exist. If `output` is given and is not `master`: check the target (section 5), then set it. If `sends` is given: for each send in order, check its target, then fail if an earlier send has the same target (`precondition_failed`); then replace the send list. After both, the whole routing graph is checked for cycles (`precondition_failed`). | `not_found`, `precondition_failed` |

Target checks: a target equal to the track is `precondition_failed`; a target that does not exist is `not_found`; a target that is not a bus is `precondition_failed`.

**Devices**

| Operation        | Parameters                                                         | Checks and effects (in order)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Errors                                               |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `instrument.set` | `trackId`, `instrument` (Device or `null`)                         | Track must exist. For `null`: if the track has an instrument and an automation lane on this track targets it, fail with `precondition_failed`; otherwise clear the instrument. Otherwise: parse the device; its id must be unused project-wide, unless it equals the current instrument's id (`precondition_failed`); its `assetId`, if any, must exist (`not_found`); then, if the track has an instrument with a different id and an automation lane on this track targets it, fail with `precondition_failed`; then set the instrument. The device type is not checked against the track kind here. | `not_found`, `invalid_params`, `precondition_failed` |
| `effect.insert`  | `trackId`, `effect`, `index?`                                      | Track must exist. Parse device. Id unused project-wide. Asset exists if given. Insert at `min(index ?? length, length)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `not_found`, `invalid_params`, `precondition_failed` |
| `effect.update`  | `deviceId`, `patch` (`name`, `bypass`, `parameters`, `extensions`) | Device is located among instruments and effects; it must exist. Parse patch. Assign `name`, `bypass`, `extensions`. `parameters` entries set values; an entry of `null` deletes the key. The device type is not changeable.                                                                                                                                                                                                                                                                                                                                                                            | `not_found`, `invalid_params`                        |
| `effect.remove`  | `deviceId`                                                         | Device must exist. If it is an instrument, fail (use `instrument.set` with `null`). Otherwise, if an automation lane on this track targets it, fail with `precondition_failed`. Otherwise remove it from the effect list.                                                                                                                                                                                                                                                                                                                                                                              | `not_found`, `precondition_failed`                   |

**Automation**

| Operation                  | Parameters                                    | Checks and effects (in order)                                                                                                                                                                                                                                                                                                                                                                       | Errors                                               |
| -------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `automation.lane.add`      | `trackId`, `lane`                             | Track must exist. Parse lane. Lane id unused project-wide. If the target is a device: the device must exist (`not_found`) and must be on this track (`precondition_failed`). Append.                                                                                                                                                                                                                | `not_found`, `invalid_params`, `precondition_failed` |
| `automation.points.update` | `laneId`, `points`, `range?` (`{start, end}`) | Lane must exist. Parse each point and sort the new points by `time`. Duplicate times within the new points fail. If `range` is given, `kept` is the existing points outside `[range.start, range.end)`; if not given, `kept` is empty, so the whole lane is replaced. Merge `kept` and the new points, sort, and fail on any duplicate time. The new points are not required to lie inside `range`. | `not_found`, `invalid_params`, `precondition_failed` |
| `automation.lane.remove`   | `laneId`                                      | Lane must exist. Remove.                                                                                                                                                                                                                                                                                                                                                                            | `not_found`                                          |

**Assets**

| Operation      | Parameters | Checks and effects (in order)                                                                                                                                           | Errors                                   |
| -------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `asset.link`   | `assetId`  | If the asset is already in `assets`, fail. Look up the id in the host store; if absent, fail with `asset_not_found`. Append a copy of the store descriptor to `assets`. | `precondition_failed`, `asset_not_found` |
| `asset.unlink` | `assetId`  | Asset must be in `assets`. Fail if any device (instrument or effect) or audio clip references it. Remove it.                                                            | `not_found`, `precondition_failed`       |

## 7. Invariants and what is not checked

### 7.1 Invariant checks

The host MUST run the invariant set below before it accepts a state produced by a transaction, an accepted proposal whose base has changed, or an undo or redo. A violation rejects the state. The reference host reports a transaction violation as `validation_failed` and an undo or redo violation as `undo_conflict`. Each violation is one diagnostic with the diagnostic code `invariant_violation`. The reference host reports every violation, not only the first. It does not emit them in the numeric order below: it checks id spaces, note ids, tempo and meter, then per-clip checks (4, 5, 6), then 7, 8, 9, 10, 11, 12, 13, and then 14 and 15 together for each audio clip.

Invariants:

1. Track, clip, device, automation lane, section and asset ids are each unique within their id space (section 7.3).
2. Note ids are unique within each MIDI clip.
3. Tempo and meter maps begin at 0, are sorted, and have no repeated positions.
4. Every audio clip's `assetId` refers to an asset in `assets`.
5. Every track kind is compatible with its clips (section 4).
6. The note count of each MIDI clip is not above `maxNotesPerClip`.
7. Every device `assetId` refers to an asset in `assets`.
8. Every `parentId` refers to an existing track, and the parent graph is acyclic.
9. Every routing target (output and send) exists, differs from its track, is a bus, and the routing graph is acyclic.
10. The track count is not above `maxTracks`.
11. For each automation lane whose target is a device, `deviceId` refers to the track's instrument or to one of the track's effects.
12. The automation points of each lane are strictly increasing by `time`.
13. No track has two sends with the same `targetTrackId`.
14. The `mediaType` of each audio clip's asset starts with `audio/` and is not `audio/midi`.
15. Source bounds of audio clips, for each clip whose asset has `durationSeconds`:
    - Let `len = seconds(start + duration) − seconds(start)`, where `seconds(x)` converts a clip position `x` to timeline seconds in the clip timebase (section 3.3).
    - With loop off: `sourceOffset + len × playbackRate ≤ durationSeconds`.
    - With loop on: `sourceOffset + loop.length ≤ durationSeconds`.
    - Comparisons use a tolerance of 1e-9 seconds. Assets without `durationSeconds` are not checked.

### 7.2 Defined as legal

The following are legal in AEP 1.0. A host MUST NOT reject them as invariant violations:

- Sections MAY overlap.
- MIDI controller and pitch-bend events outside the clip window `[offset, offset + duration)` are legal. They are not heard.
- Device-to-lane linkage is checked by invariant 11 (section 7.1).

### 7.3 Id spaces

The following are separate id spaces, each unique within itself: tracks; clips; devices (instruments and effects together); automation lanes; sections; assets. Notes are unique within a clip. Ids are compared by exact string equality.

## 8. Assets and provenance

An asset descriptor is the record a client sees. It carries no host filesystem path. A host MUST NOT disclose a path in any response, receipt, diagnostic or job result (`SPECIFICATION.md` section 14).

`contentHash` is `sha256:` plus the lowercase hex digest of the bytes. A host that holds the bytes SHOULD set it.

When a host stores WAV bytes of format PCM, it MAY derive `sampleRate`, `channels` and `durationSeconds` from the header. Other formats get no derived fields. The reference store always reports `availability: "available"`.

`portability: "portable"` means the asset can be identified by content hash and resolved by any host that holds the bytes. `host-local` means it is meaningful only to the issuing host. The default is `host-local`.

Provenance records how an asset was produced: a generator id, a version, parameters, a seed, engine identification and the source revision. Provenance is descriptive. A host MUST NOT require it.

Asset import media types are restricted to `audio/wav`, `audio/flac`, `audio/mpeg`, `audio/ogg`, `audio/aiff` and `audio/midi`. When the request gives no `mediaType`, the host derives it from the file extension (`wav`, `flac`, `mp3`, `ogg`, `oga`, `aif`, `aiff`, `mid`, `midi`). A media type outside the set, or one that cannot be derived, MUST be rejected with `invalid_params` at import.

Linking an asset into a project does not copy bytes into the project. Bytes stay in the host store.

## 9. Out of scope for 1.0

The following are out of scope for AEP 1.0. A host MAY offer them through namespaced extensions and namespaced capabilities (`SPECIFICATION.md` section 20):

- Digital signal processing, mixing and rendering semantics. The reference renderer is a test double that emits a manifest, not audio.
- Plugin binaries and plugin state formats.
- Recording, live input and transport control.
- Swing and groove models.
- Time-signature changes within a bar.
- Real generation models. The reference generator is a deterministic pattern test double.
- Video.
