# @wty.dev/aep-client — AEP client

Typed AEP client over any `ClientTransport` (stdio, directory, or in-memory). `AepClient.call`
sends a typed action and unwraps a succeeded result's output, throwing `AepRequestError` with
the protocol `next` step otherwise; request ids are idempotency keys and are resent after
transport errors. `lastRevision` tracks the project revision and is sent as `baseRevision` on
writes automatically.

```sh
pnpm add @wty.dev/aep-client
```

```ts
import { readFile } from 'node:fs/promises';
import { AepClient, StdioClientTransport } from '@wty.dev/aep-client';

// From a checkout of this repository, after `pnpm run build`. The reference host writes a
// fresh credential to the file given by --credential-out (mode 0600).
const credentialFile = '/tmp/aep-credential';
const transport = StdioClientTransport.spawn('node', [
  'examples/minimal-host/dist/main.js',
  '--credential-out',
  credentialFile,
]);
await transport.hello; // the host has started and written the credential
const credential = (await readFile(credentialFile, 'utf8')).trim();
const client = await AepClient.connect({ transport, credential });

const caps = await client.capabilities();
const { project } = await client.inspect();
const receipt = await client.commit({
  operations: [
    {
      op: 'midi.notes.add',
      clipId: 'c-midi',
      notes: [{ id: 'hat-1', pitch: 42, start: 0, duration: 0.25, velocity: 90, channel: 9 }],
    },
  ],
});
await client.close();
```

`StdioClientTransport`, `DirectoryClientTransport` and `InMemoryTransport` are re-exported from
`@wty.dev/aep-transport`. See [`specs/core/SPECIFICATION.md`](../../specs/core/SPECIFICATION.md)
for the action set.
