# Contributing to AEP

Thanks for your interest in the Audio Edit Protocol. AEP is a specification plus a TypeScript
reference SDK; most changes touch both.

## Development setup

- Node.js 24 LTS
- pnpm (version pinned by the `packageManager` field in `package.json`)

```sh
pnpm install
pnpm build
```

## Commands

| Command                  | Purpose                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `pnpm build`             | Compile all packages (`tsc -b`)                               |
| `pnpm test`              | Run the vitest suite                                          |
| `pnpm run lint`          | ESLint                                                        |
| `pnpm run format`        | Prettier write                                                |
| `pnpm run format:check`  | Prettier check (CI)                                           |
| `pnpm run typecheck`     | TypeScript project + solution check                           |
| `pnpm schemas`           | Regenerate `schemas/*.schema.json` from `@wty.dev/aep-schema` |
| `pnpm run schemas:check` | Verify `schemas/` is up to date (CI)                          |
| `pnpm run conformance`   | Build and run the conformance suite                           |
| `pnpm run check`         | typecheck + lint + format:check + test                        |

## Rules

- **No arbitrary code execution.** The protocol must never provide a feature that executes
  client- or host-supplied code (no `eval`, no plugin loading, no remote script fetch).
  Device types and generators are referenced by identifier only; implementations are the
  host's responsibility.
- **Schema changes require regeneration.** Any change to `packages/schema/src` that affects
  the generated JSON Schemas must be accompanied by running `pnpm schemas` and committing the
  updated `schemas/` directory, plus a corresponding spec update under `specs/`.
- **Every security claim needs a test.** If documentation or code claims a security property
  (e.g. "paths are confined to import roots", "extensions are preserved"), there must be a
  test that would fail if the property broke.
- **ADRs for protocol-affecting decisions.** Decisions that change the wire protocol, the
  action set, or compatibility guarantees get an ADR in `docs/adr/` before implementation.
- **DCO-style sign-off is optional.** Commits may include a `Signed-off-by:` line, but it is
  not required.
- **Conventional commit messages.** Use `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`,
  `test:`, etc., with a short imperative subject.

## Releasing

Releases are cut by tag; the `release` workflow (`.github/workflows/release.yml`) does the rest.

1. Bump `version` in every `package.json` (root, `packages/*`, `examples/*`) to `X.Y.Z`.
2. Move the `Unreleased` entries in `CHANGELOG.md` under `## [X.Y.Z] - <date>`.
3. Commit, then `git tag vX.Y.Z` and push the tag.
4. The workflow verifies the tag matches the package versions, runs the full check suite, and
   publishes every public `@wty.dev/aep-*` package to npm with provenance, then creates a GitHub release.

Publishing requires the `NPM_TOKEN` repository secret (an npm access token allowed to publish
the `@wty.dev` org) and `id-token: write` for provenance attestations.
