# Development

## Prerequisites

- [Bun](https://bun.sh) at the version pinned in `package.json` (`packageManager`). Bun is the package manager and script runner.
- Node 24 LTS (`nvm use` reads `.nvmrc`). The relay runs on Node in production, so tests and tooling run on Node too.

## Setup

```sh
bun install
```

This also points git at the hooks in `.husky/`: `pre-commit` runs ESLint and Prettier on staged files, and `commit-msg` runs commitlint.

## Commands

| Command                                 | What it does                                                           |
| --------------------------------------- | ---------------------------------------------------------------------- |
| `bun run check`                         | Everything CI runs: generate, lint, format, types, tests, plan         |
| `bun run generate`                      | Generated code (Paraglide, route trees, wrangler types); not committed |
| `bun run lint`                          | ESLint, type-aware                                                     |
| `bun run format`                        | Prettier, writes changes                                               |
| `bun run typecheck`                     | `tsc --noEmit` in every package                                        |
| `bun run test`                          | Vitest in every package                                                |
| `bun run --filter @ptbk/relay <script>` | A script in one package                                                |

## Dependencies

Supply-chain rules (spec, Security hardening item 10):

- `bunfig.toml` refuses versions published less than **7 days** ago and saves **exact** versions. `bun.lock` is committed and CI installs with `--frozen-lockfile`.
- Install scripts run only for the packages listed in `trustedDependencies` in the root `package.json` (esbuild, sharp, workerd). Adding one is its own PR, approved by a human, with the reason.
- A third-party package used by more than one module is pinned once in the root workspace `catalog` and referenced as `"catalog:"`.
- Vitest is pinned to 4.1 repo-wide because Cloudflare's Workers test pool supports only that major; Dependabot ignores TypeScript, Vitest and `@types/node` majors until the toolchain catches up.
- The isolated linker makes undeclared transitive dependencies fail; declare everything you import.
- Dependabot opens weekly grouped updates with the same 7-day cooldown.
- Before adding a dependency, check whether Node, Workers or the Web platform already does the job.

Shared dev tooling (TypeScript, ESLint, Vitest) lives in the root `package.json`. Runtime dependencies go in the package that uses them: `bun add <pkg> --cwd apps/relay`.

## Parallel work

Each task runs in its own git worktree, so several agents (or people) can build, test and commit at the same time:

```sh
git worktree add ../app-r-01 -b feat/r-01-sni-parser origin/main
cd ../app-r-01 && bun install
```

Remove it after the merge with `git worktree remove ../app-r-01`. The full procedure is in [AGENTS.md](../AGENTS.md#working-on-a-task).

## Adding a module

1. Create `apps/<name>` or `packages/<name>` with `package.json` (`"name": "@ptbk/<name>"`, `"private": true`, `typecheck` and `test` scripts; packages also get `"exports": { ".": "./src/index.ts" }`), `tsconfig.json` extending `../../tsconfig.base.json`, `src/` and a `README.md`.
2. Add its scope to `commitlint.config.js` and to [conventions.md](conventions.md).
3. Describe it in [architecture.md](architecture.md), and record why in an ADR if it changes the architecture.

Workspace packages are referenced as `"@ptbk/protocol": "workspace:*"`, so they always resolve locally, never from npm.

## CI

GitHub Actions in `.github/workflows`:

- `ci.yml`: install, then `bun run check` as one step (generate, lint, format, types, tests, plan), so whatever runs locally runs in CI; `engine-ui-csp`, which runs the built engine UI in Chromium under the engine's CSP (`bun run --filter @ptbk/engine-ui test:csp`); and a zizmor audit of the workflows themselves.
- `commits.yml`: commitlint on every commit in a PR and on the PR title.
- `ui-release.yml`: builds, signs and publishes the engine UI bundle on a `ui-v*` tag push (see [UI releases](#ui-releases)).

Workflow rules: actions pinned to full commit SHAs, `permissions: contents: read` by default, `persist-credentials: false`, no caches, no `pull_request_target`, untrusted values (PR title, branch names) passed through `env`, never interpolated into scripts.

## UI releases

The engine UI ships as a signed bundle ([ADR 0003](adr/0003-ui-as-signed-bundle.md), task X-03). Pushing a tag is the only trigger, because C-06 pins the Sigstore build trigger to `push`: a manually dispatched run could never verify.

| Tag                    | What runs                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ui-v<version>`        | `<version>` must equal `apps/engine-ui/package.json`. Build, sign, staging signature, `release:verify`, upload to staging R2 |
| `ui-v0.0.0-dryrun.<n>` | Dry run, `<n>` a positive integer: everything above except the upload. `0.0.0-dryrun.<n>` sorts below every real version     |

The workflow has three jobs:

1. **build**: checks the tag, runs `check` and `test:csp`, then `pack` and `verify-reproducible` (two more builds in fresh worktrees with another TZ, locale, umask and path, compared byte for byte with the first).
2. **sign** (the only job with `id-token: write`): signs the archive keylessly (`engine-ui.tar.zst.sigstore.json`), writes the C-06 `ReleaseEntry` payload bytes once (`release-payload.json`) and attests them with `sigstore.attest()`, which logs a DSSE entry in Rekor with an RFC 3161 timestamp (`release-provenance.sigstore.json`).
3. **publish** (GitHub environment `staging`, reviewer required): signs the payload's DSSE PAE with the staging release key, writes the `SignedRelease` (`release.json`), runs `release:verify` against the staging trust policy, and, unless it is a dry run, uploads `ui/<version>/engine-ui.tar.zst`, `ui/<version>/manifest.json`, `ui/<version>/engine-ui.tar.zst.sigstore.json` and `release-log/ui-<version>.json`. A version that exists is never overwritten: any existing key stops the upload, and every PUT carries `If-None-Match: *`.

What the `staging` environment needs (repository settings, set by a maintainer):

| Name                              | Kind     | Value                                                                                    |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `UI_STAGING_RELEASE_KEY`          | secret   | base64url of the 32-byte Ed25519 seed whose public key is in `trust-policy.staging.json` |
| `UI_STAGING_R2_ACCESS_KEY_ID`     | secret   | R2 API token access key ID, write access to the staging bucket only                      |
| `UI_STAGING_R2_SECRET_ACCESS_KEY` | secret   | its secret                                                                               |
| `UI_STAGING_R2_ENDPOINT`          | variable | `https://<account id>.r2.cloudflarestorage.com`                                          |
| `UI_STAGING_R2_BUCKET`            | variable | the staging bucket name                                                                  |

The environment allows deployments only from tags matching `ui-v*`.

### Cutting a UI release

```sh
# bump apps/engine-ui/package.json "version", merge it, then on that commit of main:
git tag ui-v0.2.0 && git push origin ui-v0.2.0
# a dry run of the whole pipeline without the upload:
git tag ui-v0.0.0-dryrun.4 && git push origin ui-v0.0.0-dryrun.4
```

Approve the `publish` job when it waits for the `staging` environment. A dry run's `release.json` is a workflow artifact (`ui-release`).

### Verifying a release

Download `ui/<version>/engine-ui.tar.zst` and `ui/<version>/manifest.json`, and `release-log/ui-<version>.json` saved as `release.json`, into one directory (or download the `ui-bundle` and `ui-release` artifacts of a run), then:

```sh
bun run --filter @ptbk/engine-ui release:verify <dir> [--policy <trust policy>] [--trusted-root <file>]
```

It runs C-06's `verifyRelease` with the real Sigstore verifier (built on `@sigstore/verify`, exact identity, the pinned `apps/engine-ui/release/trusted_root.json`, no network): the release-key signature, the provenance with its Rekor entry and trusted time, then the archive hash and every file against the manifest. The update delay is the installing engine's concern and is not checked. Put a signed revocation list next to the files as `revocations.json` to check it too; without one, the output says so.

### Locally

| Command                                                         | What it does                                                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `bun run --filter @ptbk/engine-ui pack [--tag <tag>]`           | `release/engine-ui.tar.zst` and `release/manifest.json` from a clean tree (`--allow-dirty` to experiment) |
| `bun run --filter @ptbk/engine-ui verify-reproducible`          | Two fresh builds of `HEAD`, compared byte for byte; names the first differing file                        |
| `bun run --filter @ptbk/engine-ui release:keygen <file>`        | A staging or test release key: seed to `<file>` (0600), public key printed                                |
| `bun run --filter @ptbk/engine-ui release:refresh-trusted-root` | Refreshes the pinned Sigstore trusted root through TUF; the change lands in its own reviewed PR           |

Reproducibility depends on the exact Node version (`.nvmrc`, which also fixes the zstd library), `bun.lock`, `SOURCE_DATE_EPOCH` (the commit time) and a deterministic tar (byte-sorted entries, fixed owner, modes and mtime).
