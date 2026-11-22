# AEP — Audio Edit Protocol

**An open protocol for AI-native audio editing.**

AEP lets AI agents and automation tools inspect and edit audio projects (tracks, clips, MIDI,
tempo, routing, devices, automation, assets) through structured, validated, revision-aware
operations, without depending on a specific editor or AI provider.

AEP v0.1 is a **domain profile of MEP Core 1** (`mep/core/1`, from
[MEP](https://github.com/adunext/mep)): every AEP message is a valid MEP Core 1 request, result,
manifest or state document. That is verified against MEP's published schema
([ADR 0001](docs/adr/0001-mep-core-compatibility.md)). Interoperability with existing MEP
implementations has **not** been tested.

> **Status:** v0.1 draft. Specification and APIs will change before 1.0. Not published to npm.

## What you get

- **Atomic transactions** of 31 typed operations against an id-based canonical project model.
- **Optimistic concurrency** with `baseRevision`, and **idempotency** by request id (safe retries).
- **Receipts** that report the actual entity-level diff of every commit.
- **Scopes** (tracks, clips, time range, operations, properties) enforced on the resulting diff, so
  indirect effects can't slip through.
- **Proposals**: an agent proposes, a human accepts. Proposals never touch accepted state.
- **Undo / redo** as new revisions, with conflict detection.
- **Assets** imported only from declared host roots; clients never see host paths.
- **Async jobs** for render and generation, decoupled from project state.
- **No code execution**: projects and requests are data only.

## Repository

| Path                                                         | What                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| [`specs/core/SPECIFICATION.md`](specs/core/SPECIFICATION.md) | Protocol: envelope, actions, transactions, scopes, proposals, history, errors     |
| [`specs/audio/AUDIO-DOMAIN.md`](specs/audio/AUDIO-DOMAIN.md) | Canonical audio model, time model, operations, invariants                         |
| [`specs/core/TRANSPORT.md`](specs/core/TRANSPORT.md)         | Directory (MEP Core local), stdio NDJSON and in-memory bindings                   |
| [`specs/core/CONFORMANCE.md`](specs/core/CONFORMANCE.md)     | Conformance levels and how to test a host                                         |
| [`SECURITY.md`](SECURITY.md)                                 | Threat model, tested guarantees, limitations                                      |
| [`docs/adr/`](docs/adr/README.md)                            | Architecture decisions                                                            |
| [`docs/architecture/design.md`](docs/architecture/design.md) | Reference SDK design notes                                                        |
| [`schemas/`](schemas/)                                       | Generated JSON Schemas (draft 2020-12) for the model, operations and every action |
| `packages/schema`                                            | Zod schemas and TS types (source of truth for `schemas/`)                         |
| `packages/core`                                              | Errors, canonical JSON, idempotency ledger, entity diff/undo, safe paths          |
| `packages/host`                                              | Host SDK and in-memory reference engine (`AepHost`)                               |
| `packages/transport`                                         | Directory, stdio and in-memory bindings                                           |
| `packages/client`                                            | Typed client SDK (`AepClient`)                                                    |
| `packages/testing`                                           | Conformance suite and `aep-conformance` CLI                                       |
| `examples/minimal-host`                                      | Reference host process (`aep-reference-host`)                                     |
| `examples/minimal-client`                                    | Demo client that drives the host as a separate process                            |

## Quick start

Requires Node 24 and pnpm.

```sh
pnpm install
pnpm run build
pnpm test              # unit + integration tests
pnpm run conformance   # conformance suite against the reference host process
pnpm run demo          # scripted client session against the reference host
```

## Example

```ts
import { AepClient, StdioClientTransport } from '@aep/client';

// The reference host writes a fresh credential to a 0600 file; read it from there.
const transport = StdioClientTransport.spawn('node', [
  'examples/minimal-host/dist/main.js',
  '--credential-out',
  credentialFile,
]);
const client = await AepClient.connect({ transport, credential });

const { project } = await client.inspect();
const receipt = await client.commit({
  label: 'Add a hi-hat',
  scope: { clips: ['c-drums'] },
  operations: [
    {
      op: 'midi.notes.add',
      clipId: 'c-drums',
      notes: [{ id: 'n1', pitch: 42, start: 0, duration: 0.25, velocity: 90, channel: 9 }],
    },
  ],
});
// receipt.changes is the entity-level diff; receipt.revision the new revision.
// Non-success results throw AepRequestError { code, next, message }.
```

## How an editor implements AEP

1. **Map your project to the canonical model** (`specs/audio/AUDIO-DOMAIN.md`): stable ids for
   tracks, clips, notes, devices, lanes, sections and assets; beats-or-seconds timebases; tempo and
   meter maps. Unsupported features are simply not advertised.
2. **Implement the operations you support** as pure functions on that model, and the invariants.
   Transactions must be atomic: apply to a copy, validate, then swap.
3. **Wrap them in the MEP Core 1 envelope**: authenticate sessions, check roles, dedupe by request
   id, compare `baseRevision`, return receipts with the diff. In TypeScript you can embed
   `@aep/host` directly. Otherwise use it as the reference for behavior.
4. **Advertise capabilities** in `aep.capabilities` (operations, track kinds, device types,
   generators, limits). Clients must adapt to them.
5. **Expose a binding**: the MEP directory binding (simplest for desktop apps) or stdio.
6. **Run the conformance suite** against your host via the launcher contract
   (`packages/testing/README.md`).

Device parameters, rendering and generation stay host-defined: AEP carries validated parameters
and asset references, never DSP or model code.

## Out of scope

AEP is a protocol and SDK. It is not a DAW, UI, synthesizer, DSP or rendering engine, generation
model, plugin host or cloud service.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
