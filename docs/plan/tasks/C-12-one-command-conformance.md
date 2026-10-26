# C-12. The whole conformance run in one command

- **Lane:** Contracts · **Module:** `packages/conformance` (plus the conformance CI job and the engine integration guide) · **Milestone:** M5
- **Depends on:** C-08, C-09, C-10
- **Status:** in progress (feat/c-12-one-command-conformance)
- **Spec:** Interfaces (draft) 2 and 3; Build plan (Mock engine first, real engine last); ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md)

## Goal

`ptbk-conformance --engine-cmd … --suite engine-api,registration,heartbeat,tunnel,ui-loader` runs every suite, the engine API included, against engines the harness starts. The engine maintainer's definition of done becomes one conformance command plus the dev stack check.

## Context

With `--engine-cmd` the CLI refuses `--suite engine-api` (exit 2): the engine API suite (C-05) runs only against `--base-url`, so the engine maintainer has to run the engine separately, behind the dev stack's relay in Docker, and point a second command at it ([AGENT_BRIEF.md](../../engine-integration/AGENT_BRIEF.md), [implementation-plan.md](../../engine-integration/implementation-plan.md), [testing-against-the-platform.md](../../engine-integration/testing-against-the-platform.md), [conformance.md](../../engine-integration/conformance.md)). Everything needed to run it inside the harness already exists: C-08's session factories (`--mock-control`, `--engine-session-cmd`), C-09's fake relay with `endpointFor` (a `fetch` that reaches the engine's own origin through a tunnel stream) and `ctx.engineTarget`, which C-10's `ui-loader` suite already uses.

## Scope

- **`engine-api` as a platform suite** (`node/suites/engine-api/`): the portable `ENGINE_API_SUITE`, unchanged, run against one registered engine behind a fake relay (`startTunnelRelay` + `startRegisteredEngine` + `relay.endpointFor`), with the target from `ctx.engineTarget`. One engine serves the whole suite, since its checks create and delete their own resources. The target carries the engine public key from the registration, so `engine-api.engine.id-matches-key` runs. In `PLATFORM_SUITES`, first, so a run without `--suite` runs everything.
- **Suite fixtures in the harness**: a fixture shared by one suite's checks, opened by the first check (or the version probe) that asks, in a scope of its own bounded by the run's signal rather than one check's, and torn down after the suite's last check. A failed open fails every check that asks for it, at once. A failed check's report carries the shared engine's output, as other platform checks carry their own engines'.
- **Runner**: the version probe runs before a suite's first selected check, so a run that selects no `engine-api` check starts no shared engine; an after-suite hook for the teardown.
- **CLI**: `--suite engine-api` with `--engine-cmd`; `--no-gateway` applies to it. `--engine-public-key`, `--target-module` and `--mock-control-url` are refused with `--engine-cmd` (the harness knows the key and gets sessions from `--mock-control` or `--engine-session-cmd`). `--base-url` mode is unchanged.
- **Tests**: a CLI test for the combined command; self-test runs of the combined suites against the mock engine with `--mock-control` and with `--engine-session-cmd`; harness tests for suite fixtures (shared once, torn down after the suite, a failed open, engine output on failure). Package coverage stays at or above 90% for lines and branches.
- **CI**: the conformance job runs the platform and engine API suites in one step. The engine API step behind the real relay stays as an integration check of the relay with the mock.
- **Docs**: the four guides above give one command plus the dev stack check as the definition of done; the conformance README describes the engine API suite in harness runs.

## Out of scope

- Changing any check or check ID.
- Restarting the shared engine between checks, or one engine per check.
- The real engine's `conformance-session` command (engine team, ENG-99).

## Design notes

- The shared fixture lives in a harness scope with its own engines, fixtures and directories; the per-check scope still owns the check's cleanups (the engine API checks delete what they create through `ctx.resources`).
- Per-check timeouts are the run's `--timeout-ms`, as with `--base-url`. Opening the shared engine counts against the version probe, which runs first.
- Without a session factory the target answers no sessions, so only the checks that need none run; the others skip as they do with `--base-url` and no credentials.

## Acceptance criteria

- [ ] `--engine-cmd … --mock-control --suite engine-api,registration,heartbeat,tunnel,ui-loader` passes against the mock engine (CLI test and CI).
- [ ] The engine API suite passes through the harness against the mock with `--mock-control` and with `--engine-session-cmd`; `--no-gateway` skips the gateway check.
- [ ] `--base-url` mode behaves as before; its tests are unchanged.
- [ ] The package's coverage stays at or above 90% for lines and branches.
- [ ] The exact documented command passes with the mock as the engine under test at the default heartbeat cadence; the PR shows its summary line.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- A full run at the default 60 s heartbeat cadence takes longer than one with a development interval; the CI job keeps the short interval for everything but the cadence check.
