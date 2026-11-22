# ADR 0005: Extension architecture

Status: Accepted, 2026-11-22

## Context

Publishers need to attach data to AEP entities without changing the schema: plugin state, vendor metadata, custom devices and similar. The core model cannot predict all of it. Without a rule, publishers would collide on names, and the host would have no way to tell core fields from extension data.

Devices also need a place to be named. AEP does not standardize plugin binaries, so a device's `type` is a namespaced string whose meaning belongs to the publisher.

## Decision

1. **Extensions are a map on each entity.** Entities that accept extension data have an `extensions` object. Its keys match `^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$` and its values are any JSON value. Every other property of the entity is closed.
2. **Keys are reverse-DNS.** Publishers SHOULD use names they control, such as `com.example.reverb`.
3. **The `aep.` prefix is reserved.** AEP reserves `aep.` for its own use. In v0.1 this is a convention stated in the schema comment, not enforced (`common.ts`). A future version MAY enforce it.
4. **Device types are namespaced.** A device's `type` matches `^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$`. Built-in device types use `aep.`. Publisher device types use their own namespace.
5. **Hosts preserve and do not interpret.** A host MUST preserve extension values on round trip and MUST NOT act on them. Extension values appear in diagnostics only through their paths.
6. **Executors are registered by the embedding application.** Renderers and generators are plugged in by the host's owner. A host MUST NOT run code supplied in a project (`SPECIFICATION.md` section 15).
7. **Capabilities gate features.** A feature a host supports is named by a capability. A client checks capabilities before using an action or operation.

## Consequences

- Publishers can add data without a schema change and without collisions if they follow the reverse-DNS rule.
- Hosts that do not understand an extension still store and return it. A project can move between hosts without losing publisher data.
- The `aep.` reservation is not enforced, so a publisher can write an `aep.` extension key. A conforming host MAY reject such a key; the reference host does not. This is an open item.
- A plugin's state is opaque to AEP. It is stored in `extensions` or in an asset. AEP makes no promise that the state stays valid across plugin versions.
- Extension values count toward the request size limit and the project size. A host that limits project size must count them.

## Alternatives considered

- **Open objects everywhere.** Rejected. Closed core objects are what let a host detect typos and unknown fields.
- **A single untyped `metadata` bag.** Rejected for entities. Project-level `metadata` exists, but per-entity data needs keys that cannot collide with core fields.
- **Plugin binaries in the protocol.** Rejected. Binaries are platform-specific and a security concern, and they are outside what a protocol can usefully specify.
- **Enforce the `aep.` reservation in the schema now.** Deferred. It would break any v0.1 fixture that uses such a key, and no fixture is known to need it. It is recorded as an open item.
