# ADR 0002: Canonical model

Status: Accepted, 2026-11-22

## Context

A client edits an audio project through operations, and a host checks each edit. Both sides need one model: the same entities, the same ids, the same units. Without one, two hosts can disagree about what an operation means, and a client cannot tell whether a change is valid before sending it.

The model also has to support diffs, scope checks and undo. Each of these works on individual entities, so the model needs stable ids and a flattened view.

## Decision

The canonical model is a JSON document: one `Project` with tracks, clips, devices, automation lanes, sections, assets, and tempo and meter maps. It is defined by zod schemas in `@wty.dev/aep-schema` and exported as JSON Schema under `schemas/`. The schemas are the source of truth. `specs/audio/AUDIO-DOMAIN.md` describes them in prose.

Specific decisions:

1. **Closed objects.** Every entity object rejects unknown keys. Extension data lives only in `extensions`.
2. **Units are fixed.** Musical positions are beats, absolute positions are seconds, sample positions are samples and require a project sample rate. Units are stated per field.
3. **Clip time has a timebase.** A clip or section declares `beats` or `seconds`. Conversion to timeline seconds uses the tempo map.
4. **Tempo and meter are step maps.** The first point is at 0. Positions are not re-anchored when the map changes.
5. **Ids are typed by space.** Tracks, clips, devices, automation lanes, sections and assets each have one id space. Notes are unique within a clip.
6. **Flattening for diffs.** The host flattens the project into an entity map keyed by path (`flatten.ts`). Diffs, scope and undo operate on that map. Unflattening validates the result against the schema.
7. **Assets are references.** A project holds asset descriptors. Bytes live in the host store. Descriptors carry no host paths.
8. **Routing is a graph.** Each track has one output and a list of sends. The graph must be acyclic.

## Consequences

- A client can check a transaction locally against the schemas before sending it.
- Hosts that agree on the schemas agree on what a valid project is. They may still disagree on what an operation does unless `AUDIO-DOMAIN.md` section 6 is followed.
- Flattening sorts entities for a canonical order. Two hosts that flatten the same project produce the same diff.
- Storage is free. A host may keep a different internal form if its observable behaviour matches.
- Some invariants are not checked by the schemas and are checked by the invariant set instead (`AUDIO-DOMAIN.md` section 7). This split is a known source of error, and the spec records what is not checked.
- Intentional gaps remain: no ramps, no re-anchoring of beat positions on tempo change, no source length bounds on clips, and no unit for `loop.length`.

## Note, 2026-11-22

AEP 1.0 resolved three of the gaps listed under Consequences:

- Ramps: `TempoPoint.curve` (`step` or `linear`) shapes the segment to the next tempo point (`AUDIO-DOMAIN.md` section 2.2).
- `loop.length` has a defined unit (`AUDIO-DOMAIN.md` section 2.4).
- Audio clips have source bounds, enforced by invariant 15 (`AUDIO-DOMAIN.md` section 7.1).

Beat positions are still not re-anchored when the tempo map changes. The body above is kept as the record of the original decision.

## Alternatives considered

- **Store seconds only.** Rejected. Edits in musical time would then need a tempo conversion on every operation, and round-trips would drift.
- **Store beats only.** Rejected. Clips that must stay fixed in real time, such as recorded stems, cannot be expressed.
- **A binary or database format.** Rejected for the model. The model is an interchange and editing model. A host may store it however it likes.
- **Re-anchor beat positions when tempo changes.** Rejected for v0.1. It would make `tempo.update` a multi-entity rewrite with its own scope and undo problems. It is recorded as a possible future change.
- **Enforce all invariants in the schemas.** Rejected. Some invariants depend on other entities (for example, asset existence), and zod schemas validate one value at a time.
