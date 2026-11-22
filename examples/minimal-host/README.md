# aep-reference-host

The AEP reference host as a stand-alone process. It serves one AEP project over the AEP
**stdio** or **directory** binding, using the engine in `@wty.dev/aep-host`. It is the host the conformance
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
| `--data-dir <dir>`             | Durable host: persist all state in `<dir>` and restore it on start.      |
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

## Durability

Without `--data-dir` the host is volatile: everything is lost when the process ends. With
`--data-dir <dir>` it opens `AepHost.open({ dataDir })` and reports `host.durability: durable`. It
persists the project, revision history, receipts, request ledger, proposals, assets, jobs and
sessions (credential hashes only) in `<dir>` (created with mode `0700`; an existing `<dir>` must be owned by you, not a symlink, and
not writable by group or others), and restores them on the
next start, after a crash too. `--fixture` only seeds an empty `<dir>`; an existing one wins.

Sessions are created on the first start only. On later starts the host finds each session of
`--session-config` through its `<credentialFile>.session.json`, keeps it with the same id and
credential, and leaves the credential files untouched, so clients keep using their credentials.
If a credential file or descriptor is missing, or the host no longer knows the session, a new
session is created and the files are rewritten. If the session's entry in `--session-config`
changed (client, role, scope, allowedActions or expiresAt), the old session is revoked and a new
one is issued, so a narrowed grant takes effect on restart. A session is persisted before its credential file
is written.

```sh
node examples/minimal-host/dist/main.js --session-config sessions.json --data-dir ~/aep-data
```

Commits are persisted before they are answered; the host also flushes on a normal shutdown (stdin
closed over stdio, SIGTERM or SIGINT with the directory binding). After a crash, requests the
host had reserved but not finished answer `outcome_uncertain` and non-terminal jobs become `failed`
(SPECIFICATION.md section 17).

## Security properties

- Credentials are never printed and never appear on the command line.
- Logs go to stderr only, because stdout is the stdio channel.
- The host executes no project-supplied code. `asset.import` reads only below the configured
  `--import-root` directories.

Usage errors exit with code 2.
