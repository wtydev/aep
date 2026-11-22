# @wty.dev/aep-transport — AEP transports

Transport bindings for the AEP `aep/1` wire protocol. `ClientTransport` is the client side
(`send`/`manifest`/`state`/`close`); `RequestHandler` is the host side. Three bindings are
provided: `InMemoryTransport` for in-process hosts, `StdioClientTransport`/`serveStdio` for the
NDJSON stdio binding, and `DirectoryClientTransport`/`DirectoryHostBinding` for the directory
binding (`aep.json` manifest, `requests/`/`results/` files).

```sh
pnpm add @wty.dev/aep-transport
```

```ts
import { AepHost, demoProject } from '@wty.dev/aep-host';
import { InMemoryTransport, serveStdio } from '@wty.dev/aep-transport';

const host = new AepHost({ project: demoProject() });

// in-process
const transport = new InMemoryTransport(host);

// or, inside a host process, serve over its own stdin/stdout
await serveStdio({ handler: host, input: process.stdin, output: process.stdout });
```

`serveStdio` resolves when the input ends. A client in another process connects with
`StdioClientTransport.spawn(command, args)`.

The binding formats are specified in
[`specs/core/TRANSPORT.md`](../../specs/core/TRANSPORT.md).
