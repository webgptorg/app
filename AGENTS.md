# Agent instructions

Read this before changing anything. It applies to Claude Code, Codex and any other coding agent, and to humans too.

## What this repo is

The private, commercial half of the Promptbook zero-trust interface:

- `apps/relay`: SNI passthrough relay. Browsers reach engines behind NAT through it; it never decrypts.
- `apps/dashboard`: app.ptbk.io. Account, engine list, billing, status. Stores no engine content.
- `apps/engine-ui`: the full app UI, shipped as a signed static bundle that the engine downloads, verifies and serves ([ADR 0003](docs/adr/0003-ui-as-signed-bundle.md)).
- `apps/mock-engine`: a real process that speaks the real contracts with fake data, so everything works here without the real engine ([ADR 0004](docs/adr/0004-mock-engine-and-conformance.md)).
- `packages/protocol`, `packages/engine-api`, `packages/conformance`: the contracts. MIT, portable, and moving to the public repo later ([ADR 0002](docs/adr/0002-public-private-split.md)).

The engine is open source in `webgptorg/promptbook`, built by the engine team. Never commit there.

## Read before you start

1. [docs/plan/README.md](docs/plan/README.md): the implementation plan and task status. **Start here.**
2. Your task brief in [docs/plan/tasks/](docs/plan/tasks/).
3. [docs/engineering.md](docs/engineering.md): module design and TypeScript rules. Non-negotiable.
4. [docs/architecture.md](docs/architecture.md) and the [ADRs](docs/adr/).
5. The sections of the [spec](docs/spec/zero-trust-spec.md) your brief names.

## Commands

- `bun install`: dependencies and git hooks. Bun is the package manager only; the runtime is Node 24 (relay, mock engine), Cloudflare Workers (dashboard) and the browser (engine-ui). Never use `Bun.*` or `bun:*` APIs.
- `bun run check`: lint, format check, typecheck, tests. Must pass before every commit you push.
- `bun run --filter @ptbk/<module> <script>`: a script in one module.
- `bun add <pkg> --cwd apps/<module>`: a runtime dependency for one module (see dependency rules below).

## Rules that must never break

These are the zero-trust guarantees. A change that weakens one needs an ADR and a human decision. Stop and ask instead.

1. **The relay never decrypts engine traffic.** It reads the SNI and pipes bytes. It terminates TLS only for its own hostname. It never holds an engine key or certificate.
2. **The dashboard stores no engine content**, not even encrypted: no prompts, messages, files or agent output.
3. **Nothing we host serves code that runs on an engine's origin.** The UI reaches engines only as a signed, logged release.
4. **engine-ui runs under the engine's strict CSP**: no inline scripts or styles, no `eval`, no external origins, Trusted Types. Model output never becomes executable.
5. **Contracts are strict and versioned.** Schemas reject unknown fields. A breaking change is a new version next to the old one.
6. **No dynamic code execution** (`eval`, `new Function`, `vm`). ESLint enforces it.
7. **No secrets in the repo, logs, fixtures or snapshots.** Logs never contain content, tokens, keys or cookies.

## Working on a task

Several agents work in parallel. This procedure keeps them out of each other's way.

1. **Pick a task.** Run `bun run plan --next` on fresh `main` and take the first task listed, unless you were assigned one. Check open PRs and remote branches (`gh pr list`, `git branch -r`) so you don't take one someone else is on.
2. **Isolate.** Create a worktree and branch from fresh `main`:
   ```sh
   git fetch origin
   git worktree add ../app-<task-id> -b <type>/<task-id>-<slug> origin/main
   ```
   e.g. `feat/r-01-sni-parser`. Work only in that worktree.
3. **Claim it.** First commit: set the **Status** line in your task's brief to `in progress (<branch>)`, then push the branch and open a draft PR titled like the final commit (e.g. `feat(relay): parse SNI from the TLS ClientHello`), with `Refs: <task-id>` in the body.
4. **Build it.** Follow the brief and [engineering.md](docs/engineering.md). Stay inside the task's module. If you must touch another module or a root file (workspaces, ESLint, commitlint scopes), keep that change minimal and say so in the PR.
5. **Test it.** Tests come with the code, not after. A bug fix starts with a failing test.
6. **Self-review** before you mark the PR ready:
   - Every acceptance criterion in the brief is met, and you can point to the test or output that shows it.
   - `bun run check` passes locally; e2e passes if your task touches a flow it covers.
   - None of the rules above is weakened; no secrets, no content in logs.
   - No dead code, no TODOs without a task ID, comments explain why, not what.
   - Docs updated where behaviour or architecture changed (module README, architecture.md, an ADR for a decision).
7. **Finish.** Set the brief's **Status** line to `done (#<PR>)`, mark the PR ready, wait for CI to go green, then squash-merge:
   ```sh
   gh pr merge --squash --delete-branch
   ```
   If `main` moved, rebase on it and rerun the checks first. Never force-push `main`, never merge with red CI, never bypass hooks (`--no-verify`).
8. **Clean up.** `git worktree remove ../app-<task-id>`.

**When to stop and ask a human instead:** the brief is ambiguous in a way that changes behaviour; a rule above would bend; a dependency would add install scripts or a new runtime service; the task turns out to need a decision listed under "Decisions needed from humans" in the plan.

## Conventions

- Conventional Commits; scopes: `relay`, `dashboard`, `engine-ui`, `mock-engine`, `protocol`, `engine-api`, `conformance`, `e2e`, `infra`, `docs`, `ci`, `deps`, `repo`. See [docs/conventions.md](docs/conventions.md).
- The PR title becomes the commit on `main`, so it must be a good commit message.
- Apps never import other apps. Contract packages import nothing from `@ptbk/*`.
- Comment the why, not the what.

## Dependencies

Prefer none. If one is needed: it must be at least 7 days old (Bun enforces it), maintained, and small for what it does. Its install scripts stay blocked; adding it to `trustedDependencies` needs a human. Runtime dependencies go into the module that uses them; shared dev tooling stays at the root.

## Predecessor code

Porting code from the old engine's UI (`promptbook/apps/agents-server`) and the `agents-server` prototype is allowed (decision recorded in the plan). Port, then adapt: ported code must meet the CSP rules, [engineering.md](docs/engineering.md) and our stack (Tailwind 4, TanStack, no Next.js server actions). Never port the old engine's server code into our services; its security problems are why this system exists.
