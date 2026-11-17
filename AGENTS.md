# Agent instructions

Read this before changing anything. It applies to Claude Code, Codex and any other coding agent, and to humans too.

## What this repo is

The private, commercial half of the Promptbook zero-trust interface:

- `apps/relay`: SNI passthrough relay. Browsers reach engines behind NAT through it; it never decrypts.
- `apps/dashboard`: app.ptbk.io. Account, engine list, billing, status. Vite SPA + Hono API in one Worker, D1 via Drizzle. Stores no engine content.
- `apps/engine-ui`: the full app UI, shipped as a signed static bundle that the engine downloads, verifies and serves ([ADR 0003](docs/adr/0003-ui-as-signed-bundle.md)).
- `apps/mock-engine`: a real process that speaks the real contracts with fake data, so everything works here without the real engine ([ADR 0004](docs/adr/0004-mock-engine-and-conformance.md)).
- `packages/ui`: the design system both frontends share. Private, CSP-safe, imports no app or contract package.
- `packages/protocol`, `packages/engine-api`, `packages/conformance`: the contracts. MIT, portable, and moving to the public repo later ([ADR 0002](docs/adr/0002-public-private-split.md)).

The engine is open source in `webgptorg/promptbook`, built by the engine team. Never commit there.

## Read before you start

1. [docs/plan/README.md](docs/plan/README.md): the implementation plan and task status. **Start here.**
2. Your task brief in [docs/plan/tasks/](docs/plan/tasks/).
3. [docs/engineering.md](docs/engineering.md): module design and TypeScript rules. Non-negotiable.
4. [docs/architecture.md](docs/architecture.md) and the [ADRs](docs/adr/).
5. The sections of the [spec](docs/spec/zero-trust-spec.md) your brief names.
6. For UI work: [docs/design/ui.md](docs/design/ui.md) and ADRs [0015](docs/adr/0015-ui-architecture-and-design-system.md) and [0016](docs/adr/0016-engine-capabilities.md).

## Commands

- `bun install`: dependencies and git hooks. Bun is the package manager only; the runtime is Node 24 (relay, mock engine), Cloudflare Workers (dashboard) and the browser (engine-ui). Never use `Bun.*` or `bun:*` APIs.
- `bun run check`: lint, format check, typecheck, tests. Must pass before every commit you push.
- `bun run --filter @ptbk/<module> <script>`: a script in one module.
- `bun add <pkg> --cwd apps/<module>`: a runtime dependency for one module (see dependency rules below).

## Run it locally

When someone asks to see or try the product, possibly someone who has never used a terminal, this is the path. It changes nothing on their machine beyond what they install. Details and troubleshooting: [docs/development.md](docs/development.md#local-stack).

1. Check for Docker (OrbStack or Docker Desktop), Bun and Node 24, and install what is missing. macOS or Linux only; Windows is not supported yet, so say so instead of trying.
2. From an up-to-date `main`: `bun install`, then `bun run dev:stack up --no-system`. The first run builds images for several minutes. Say so, and don't take the silence for a hang.
3. Run the Chrome line that command prints. It opens the dashboard in its own profile with the flags the stack needs. Tell them this window is the product and that the certificate warnings are switched off only for it.
4. Walk them through it: sign up at `https://app.ptbk.test:8444/` (emails arrive at `/__dev/mailbox`), the fake Checkout under Billing, then "New engine" on Engines, then run `bun run dev:link <code>` with the code the page shows. The engine turns online within a minute and "Open" goes to it.
5. `bun run dev:stack down` when they're done. It keeps the account and engine, but not the fake subscription. `reset` deletes the account and engine, so ask first.

They have to do these themselves: approve Docker's first start and any password prompt, and confirm the passkey in Chrome. Everything runs against the mock engine with fake data, never a real one.

## Rules that must never break

These are the zero-trust guarantees. A change that weakens one needs an ADR and a human decision. Stop and ask instead.

1. **The relay never decrypts engine traffic.** It reads the SNI and pipes bytes. It terminates TLS only for its own hostname. It never holds an engine key or certificate.
2. **The dashboard stores no engine content**, not even encrypted: no prompts, messages, files or agent output.
3. **Nothing we host serves code that runs on an engine's origin.** The UI reaches engines only as a signed, logged release.
4. **engine-ui runs under the engine's strict CSP**: no inline scripts or styles, no `eval`, no external origins, Trusted Types. Model output never becomes executable.
5. **Contracts are strict and versioned.** Servers parse input strictly and reject unknown fields; clients read responses tolerantly (validate known fields, strip unknown). A breaking change is a new version next to the old one.
6. **Every HTTP route is declared through the typed route helper** with strict input validation, an explicit auth mode and a permission or rate limit; roles and permissions are closed allowlists, deny by default ([engineering.md](docs/engineering.md#request-handling-every-http-endpoint)).
7. **No dynamic code execution** (`eval`, `new Function`, `vm`). ESLint enforces it.
8. **No secrets in the repo, logs, fixtures or snapshots.** Logs never contain content, tokens, keys or cookies.

## Working on a task

Several agents work in parallel, and `main` has no branch protection yet: **you are the gate**. This procedure keeps agents out of each other's way and `main` green.

1. **Prepare.** `nvm use` (Node 24, from `.nvmrc`); `gh auth status` works.
2. **Pick a task.** Take the task you were assigned. Otherwise run `bun run plan --next` on fresh `main`, then check that nobody has claimed it: claims live on unmerged branches, so look at `gh pr list --state open --json number,title,headRefName,body` for its task ID. Take the first unclaimed one.
3. **Isolate.** One worktree and branch per task, from fresh `main`, and install in it (this also installs the git hooks there):
   ```sh
   git fetch origin
   git worktree add --no-track -b <type>/<task-id>-<slug> ../app-<task-id> origin/main
   cd ../app-<task-id> && bun install
   ```
   e.g. `feat/c-01-protocol-primitives`. Work only in that worktree. Never use `git stash`: the stash is shared by every worktree, so a parallel agent can pop your change or you theirs. Commit work in progress to your branch instead.
4. **Claim it immediately**, before writing code: set the **Status** line in your brief to `in progress (<branch>)`, commit, then
   ```sh
   git push -u origin HEAD
   gh pr create --draft --title "<type>(<scope>): <subject>" --body "Refs: <task-id>"
   ```
   The title must be the final squash commit message. If another open PR already claims the same task, the later one closes its PR and picks another task.
5. **Build it.** Follow the brief and [engineering.md](docs/engineering.md). The brief fixes behaviour, contracts, security rules and acceptance criteria; file names, internal function names and module layout are suggestions. If a significantly cleaner design fits, use it and say why in the PR. Changing what the brief fixes needs a human. Stay inside the task's module. If you must touch another module or a shared root file (`package.json`, `eslint.config.js`, `commitlint.config.js`, a package's `src/index.ts`), keep the change minimal and say so in the PR. A large task may land as several PRs, each with `Refs: <task-id>`; the Status becomes `done (#<last PR>)` with the last one.
6. **Test it.** Tests come with the code, not after. A bug fix starts with a failing test.
   - When your task adds the first code to a module, remove `--passWithNoTests` from that module's `test` script, so a module with code can never pass CI without tests.
   - `protocol`, `engine-api` and any code that verifies signatures, tokens, sessions or permissions run `vitest run --coverage` with thresholds of at least 90% lines and branches, set in the module's `vitest.config.ts`. Never lower a threshold to get CI green.
   - Cover the reject paths, not just the happy path: every brief's negative cases (forged signature, replay, downgrade, missing permission) are tests.
7. **Stay current.** Rebase on `main` before marking ready and whenever it moved:
   ```sh
   git fetch origin && git rebase origin/main
   ```
   On a `bun.lock` conflict, take `main`'s version, run `bun install`, and commit the result. Force-push only your own branch, with `git push --force-with-lease`.
8. **Self-review** before marking ready:
   - Every acceptance criterion in the brief is met, and you can point to the test or output that shows it.
   - `bun run check` passes locally; e2e passes if your task touches a flow it covers.
   - None of the rules above is weakened; no secrets, no content in logs.
   - No dead code, no TODOs without a task ID, comments explain why, not what.
   - Docs updated where behaviour or architecture changed (module README, architecture.md, an ADR for a decision).
9. **Finish.** Set the brief's **Status** line to `done (#<PR>)`, push, then:
   ```sh
   gh pr ready <PR>
   gh pr checks <PR> --watch --fail-fast   # with `run-ci` only; must end green, if not, fix and repeat
   gh pr merge <PR> --squash --subject "<PR title> (#<PR>)" --body "Refs: <task-id>"
   git push origin --delete <branch>
   ```
   Without the `run-ci` label a PR runs only commitlint and the workflow audit, so the local checks are the gate; add `run-ci` (`gh pr edit <PR> --add-label run-ci`) when a change needs CI's browsers, Docker or VM. Pass `--subject` and `--body` explicitly: the repo's default would use a commit subject and list every commit. Never merge with red or pending checks, never force-push `main`, never bypass hooks (`--no-verify`).
10. **Verify `main`.** The next completed CI run on main (`gh run list --workflow ci.yml --branch main --limit 1`) must be green; runs on main cancel each other, so it may be a later merge's run that covers yours. If your merge broke it, fix it right away or revert your PR.
11. **Clean up** from the primary checkout: `git worktree remove ../app-<task-id>` and `git branch -D <branch>`.

**When to stop and ask a human instead:** the brief is ambiguous in a way that changes behaviour; a rule above would bend; a dependency needs install scripts beyond the approved list or adds a runtime service; the task needs a decision listed under "Still needed" in the plan.

## Conventions

- Conventional Commits; scopes: `relay`, `dashboard`, `engine-ui`, `mock-engine`, `protocol`, `engine-api`, `conformance`, `ui`, `e2e`, `infra`, `docs`, `ci`, `deps`, `deps-dev`, `repo`. See [docs/conventions.md](docs/conventions.md).
- The PR title becomes the commit on `main`, so it must be a good commit message.
- Apps never import other apps. `protocol` and `engine-api` import nothing from `@ptbk/*`; `conformance` imports only those two; `ui` imports no app or contract package. ESLint enforces it.
- Comment the why, not the what.

## Dependencies

Prefer none. If one is needed: it must be at least 7 days old (Bun enforces it), maintained, and small for what it does.

- Runtime dependencies go into the module that uses them; shared dev tooling stays at the root.
- A dependency used by more than one module is pinned once in the root workspace `catalog` and referenced as `"<name>": "catalog:"`, so there is only ever one version.
- Crypto, auth and network libraries are already pinned in the catalog at reviewed versions ([ADR 0014](docs/adr/0014-cryptography.md)): `@noble/curves`, `@sigstore/*`, `sigstore`, `@simplewebauthn/*`, `@peculiar/*`, `stripe`, `hono`, `ws`, `zod`. Always use `catalog:` for them; changing one of those versions needs a human.
- Install scripts run only for the packages in the root `trustedDependencies` (esbuild, sharp, workerd). Adding one needs a human-approved PR.
- Generated code (Paraglide output, route trees, wrangler types) is not committed. A module that has some defines a `generate` script; `bun run check` runs `bun run generate` first.

## Predecessor code

Porting code from the old engine's UI (`promptbook/apps/agents-server`) and the `agents-server` prototype is allowed (decision recorded in the plan). Port, then adapt: ported code must meet the CSP rules, [engineering.md](docs/engineering.md) and our stack (Tailwind 4, TanStack, no Next.js server actions). Never port the old engine's server code into our services; its security problems are why this system exists.
