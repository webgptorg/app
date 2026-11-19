# D-36. Dashboard: "Setup not finished" on a paired engine

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M5
- **Depends on:** C-15
- **Status:** in progress (feat/d-36-setup-not-finished)
- **Spec:** Health without content

## Goal

An owner who paired an engine but left its setup half done sees that on the dashboard, with one action that takes them back to it on the engine.

## Context

The engine keeps the setup draft itself; the dashboard learns only the heartbeat's closed enum `setup: pending | done` (C-15) and never any setup content. A missing `setup` means set up (engines without browser setup). PR #334 (Pavol) reworks `/engines/new`; stay out of those files.

## Scope

- Ingest and store `setup` with the engine status (Durable Object and the API the SPA reads).
- On the engine list and the engine page, an online engine with `setup: pending` shows "Setup not finished". Its primary action, "Continue setup", opens the engine; the engine UI lands on setup by itself. The live link progress (D-10) ends on that action instead of "Open" when the first heartbeat after the passkey says `pending`.
- en and cs copy, tests for ingest, the API and the UI states.

## Out of scope

- Reminder emails; any setup detail beyond the enum.

## Acceptance criteria

- [ ] A heartbeat with and without `setup` is accepted; the stored state follows it.
- [ ] UI tests show "Setup not finished" and "Continue setup" for `pending`, and today's view for `done` or absent.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.
