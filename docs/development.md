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

- `ci.yml`: install, then `bun run check` as one step (generate, lint, format, types, tests, plan), so whatever runs locally runs in CI; and a zizmor audit of the workflows themselves.
- `commits.yml`: commitlint on every commit in a PR and on the PR title.

Workflow rules: actions pinned to full commit SHAs, `permissions: contents: read` by default, `persist-credentials: false`, no caches, no `pull_request_target`, untrusted values (PR title, branch names) passed through `env`, never interpolated into scripts.
