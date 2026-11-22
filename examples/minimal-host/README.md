# aep-reference-host

The AEP reference host as a stand-alone process. It serves one AEP project over the MEP Core 1
**stdio** or **directory** binding, using the engine in `@aep/host`. It is the host the conformance
suite and the demo client run against.

```sh
pnpm build
node examples/minimal-host/dist/main.js --credential-out /tmp/aep.credential --verbose
```

## Options

| Flag                           | Meaning                                                                  |
| ------------------------------ | ------------------------------------------------------------------------ |
| `--transport stdio\|directory` | Binding to serve (default `stdio`). stdio serves exactly one session.    |
| `--dir <path>`                 | Directory binding: one sub-directory per session under `<path>`.         |
| `--fixture <file>`             | Project JSON to serve (default: built-in demo project, id `demo`).       |
| `--session-config <file>`      | Sessions to create (see below).                                          |
| `--credential-out <file>`      | Without `--session-config`: one `edit` session, credential written here. |
| `--import-root name=path`      | Directory `asset.import` may read from (repeatable).                     |
| `--executors reference`        | Enable the reference render and generation executors.                    |
| `--poll-ms <n>`                | Directory binding poll interval (default 25).                            |
| `--verbose`                    | Log start-up information to stderr.                                      |
| `--help`                       | Usage.                                                                   |

## Session config

```json
{
  "sessions": [
    {
      "client": "my-agent",
      "role": "propose",
      "scope": { "clips": ["c-lead"] },
      "allowedActions": ["project.describe"],
      "expiresAt": 1900000000000,
      "credentialFile": "/tmp/my-agent.credential"
    }
  ]
}
```

For every session the host generates a credential and writes it to `credentialFile` with mode
`0600`. It then writes `<credentialFile>.session.json` containing `{"session", "workspace"}`; that
file appears last, so its presence means the credential is complete.

## Security properties

- Credentials are never printed and never appear on the command line.
- Logs go to stderr only, because stdout is the stdio channel.
- The host executes no project-supplied code. `asset.import` reads only below the configured
  `--import-root` directories.

Usage errors exit with code 2.
