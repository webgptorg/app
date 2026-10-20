# M-07. Mock engine capabilities: runs, files, triggers, integrations, live simulation

- **Lane:** Mock engine · **Module:** `apps/mock-engine`, `packages/conformance`, and `packages/engine-api` for missing controller levers (see Context) · **Milestone:** M2
- **Depends on:** C-07, M-04, C-05
- **Status:** todo
- **Spec:** Build plan (Mock engine first, real engine last); Security hardening (5, 7); Enterprise-ready engine architecture; ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md), [0016](../../adr/0016-engine-capabilities.md), [0006](../../adr/0006-organizations-and-roles.md)

## Goal

The mock engine advertises and serves every C-07 capability (`runs@1`, `files@1`, `triggers@1`, `integrations@1`) and the activity feed with seeded, believable data and a live simulation where runs progress, schedules fire and files appear. The conformance suite checks each capability the target advertises.

## Context

engine-ui's feature modules (U-08 to U-12) are built and demoed against this server, so the data has to look like a real engine's: runs with steps, tool calls, costs and diffs, failures that read like real ones, schedules that fire. Like M-04, it has no shortcuts the real engine would not have (ADR 0004). State, handlers, capability gating, events and C-07's rules (cancel, retry, pause, the 409s) already live in `engine-api`'s in-memory core (C-07), which M-04 serves; sessions, the policy and faults come from M-04. This task adds seed data, the live simulation and faults on top. The simulation changes state only through the core's controller; a lever the core lacks is added there with a test, never as a second implementation in the mock. **Two modules:** the conformance checks for the new capabilities live in `packages/conformance`, so this task depends on C-05 as well as M-04. It may ship as two PRs (mock engine first), and the status line takes the last one.

## Scope

- Controller levers in `@ptbk/engine-api/in-memory`, only those still missing: for example start a scripted run with steps, attach output files and project changes to a run, set a file's scan state, set an integration's status. Each validates with C-07 schemas and emits activity and events like the existing levers (levers write no audit entries).
- `src/domain/state/seed.ts` and `scenarios.ts` extend the existing scenarios' `InMemorySeed`. The same seed, scenario and epoch still give byte-identical state.
  - `empty`: capabilities advertised, no data.
  - `small-team`: about 200 runs over 14 days across all agents.
    - Every `source` and terminal `status` is represented. Failures carry believable error codes and summaries (tool timeout, rate limit, invalid credentials).
    - Runs have progress items and tool calls in every state, usage with cost in USD, and some `retryOf` chains.
    - Some runs have project changes: a commit hash, changed files with insertion and deletion counts, and a unified diff. One diff exceeds `MAX_RUN_TEXT_BYTES` and is truncated.
  - `small-team` files: knowledge files per agent and attachments. Outputs include tiny deterministic PNGs generated from the seed (no binary fixtures). One file is `infected`, a few are `pending` or `failed`, and git-backed project files have several versions.
  - `small-team` triggers: email triggers with engine-assigned addresses, and schedules (`once`, `interval`, `cron` with time zones) in every lifecycle. Ended triggers carry each `endedReason`, and every trigger has a fire history linked to runs.
  - `small-team` integrations: MCP servers, a calendar and a GitHub repository, engine-wide and per agent. One is in `error` and one `needs-attention`. Secret refs point to seeded secrets by name, with one `missing` and one `revoked`. Tools are listed.
  - `large-fleet`: the same mix scaled for paging (about 20,000 runs, 3,000 files, 500 triggers, 300 integrations, 50,000 activity items). It seeds in under 3 s.
- `src/domain/simulation/` with `Scheduler` and `Clock` ports. Real timers live only in an adapter.
  - `run-simulator.ts`: the core already starts a `web` run for each chat turn and ends it with the reply. Other runs move `queued → running`, then through progress items and tool calls (`pending → partial → complete | error`), and end `completed` or `failed` with seeded probability, all through controller levers.
  - Cancel and retry come from the core's handlers (C-07, including 409 `run-finished` and `run-not-retryable`); the simulator ends a run with `cancelRequestedAt` as `cancelled` at its next step.
  - Completed runs may produce output files (`file.created`) and project changes.
  - `schedule-simulator.ts`: calls the controller's `fireTrigger` at `nextFireAt`, producing `schedule` runs and fire records. The lifecycle rules (`startsAt`, `endsAt`, `maxRunCount`, the right `endedReason`, paused triggers never fire) belong in the core's `fireTrigger`; add them there if missing.
  - The core emits C-07 activity and change hints on `GET /events` for every lever, through its permission filter and bounded buffer, and serves the same log on `GET /activity`. The simulator emits nothing itself.
- `MOCK_CAPABILITIES` sets the core's `capabilities` option; the 404 `capability-not-supported` gating and `GET /engine`'s `engineId` and `capabilities` come from the core. `policy.ts` maps the new permissions per role.
- Faults: `FaultPlan` gains `runFailureRate` (0–1), `stuckQueue` (runs stay `queued`, so `oldestQueuedAt` grows), `scanInfectedRate` (0–1) and `integrationErrorRate` (0–1).
- Config: `MOCK_CAPABILITIES` (comma-separated, default all four), `MOCK_SIMULATION` (`running | paused`, default `running`), `MOCK_SIMULATION_SPEED` (default 1).
- Control routes on M-04's control listener (bodies are strict zod):
  - `POST /__mock/simulation { mode, speed }`
  - `POST /__mock/simulation/advance { ms }`: advances the fake clock, deterministically, while paused.
  - `POST /__mock/runs { agentId, outcome: 'completed' | 'failed', steps }`: scripts a run.
  - `POST /__mock/inbound-email { triggerId, from, subject }`: starts an `email` run.
  - `POST /__mock/reset` gains `capabilities`.
- Conformance (`packages/conformance/src/suites/engine-api/`):
  - Suites `engine-api.runs.*`, `.files.*`, `.triggers.*`, `.integrations.*` and `.activity.*`. Each skips with reason `capability-not-advertised` when the target's `GET /engine` does not list it.
  - Shared checks: paging and filters without gaps or duplicates, and an unadvertised capability returns 404 `capability-not-supported`.
  - Runs: cancel is idempotent and gives 409 after a terminal state; retry works only from `failed`.
  - Triggers: pause and resume are idempotent, and resuming an ended trigger gives 409.
  - Files: an infected file cannot be downloaded, and content comes as an attachment with `nosniff`.
  - Integrations: a secret canary referenced by an integration never appears in integration, activity or event bytes.
  - Activity: every activity item parses as `known`, never `invalid`.
  - Permissions: the C-05 permission matrix covers every new mutating route.

## Out of scope

- UI (U-08 to U-12). Real OAuth for calendars, generic webhooks and per-tool approvals (C-07 marks them `draft` or later). Real virus scanning or git: the mock fakes the results.

## Design notes

- Faker runs only at seed time. The simulation uses the seeded `Random` and the injected `Clock`, so a run of the simulation is reproducible from seed, scenario, epoch and the sequence of `advance` calls.
- Diffs and logs are generated as plain text with a few believable files (TypeScript, Markdown, JSON). Truncation follows C-07's byte limit and flag.
- Generated PNGs are valid, small (64 × 64), and built from the seed with an in-repo encoder over `CompressionStream`. No image dependency.
- The simulation adapter can be paused, so e2e (X-04) drives time with `advance` instead of sleeping.

## Acceptance criteria

- [ ] Seed snapshot test: `small-team`, seed 42, fixed epoch gives a stable hash including the new entities. A different seed changes it, and `large-fleet` seeds in under 3 s.
- [ ] Contract test: every C-07 operation answers through the mock's HTTP server, and every response in the test run validates against its C-07 schema. With `MOCK_CAPABILITIES=runs`, the files, triggers and integrations routes return 404 `capability-not-supported`, and `GET /engine` lists only `runs@1`.
- [ ] Simulation tests with the fake clock: a scripted run passes through its steps and tool-call states and ends as scripted; a chat turn creates a linked `web` run; cancel ends a running run `cancelled`, then gives 409; retry of a failed run creates a linked run; an interval schedule fires the expected number of times over a simulated hour and stops at `maxRunCount`; a paused trigger does not fire; an inbound email starts an `email` run.
- [ ] Events test: run progress emits `run.changed` and `activity` events in order. A member without `runs.read` receives neither, and reconnecting with `Last-Event-ID` replays missed events.
- [ ] Authorisation matrix test covers every new route for each role and for explicit permission sets.
- [ ] Fault tests: `runFailureRate` within tolerance over 1,000 seeded runs; `stuckQueue` grows `oldestQueuedAt`; `scanInfectedRate` and `integrationErrorRate` take effect on the next file or check.
- [ ] Conformance:
  - [ ] Self-test fakes, one per defect, each fail their check: cancel after completion accepted, retry from `completed` accepted, a non-idempotent pause, an infected file downloadable, a secret canary in an integration response, an `invalid` activity item, and a missing permission check on a new route.
  - [ ] A target without a capability skips that capability's suite.
  - [ ] The suite passes against the mock engine in the CI job.
- [ ] Through the tunnel, the new `/__mock/*` routes return 404.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- The data shapes follow C-07, which is modelled on the predecessor. When the engine team changes a model, update the seed and the simulation in the same PR as the contract.
- Simulation speed and seeded probabilities make demos lively but can make e2e flaky if left running. X-04 pauses the simulation and advances time explicitly.
