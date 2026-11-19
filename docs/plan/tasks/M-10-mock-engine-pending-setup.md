# M-10. Mock engine: pair before setup, finish it in the browser

- **Lane:** M · **Module:** `apps/mock-engine` · **Milestone:** M5
- **Depends on:** C-15
- **Status:** in progress (feat/m-10-mock-engine-pending-setup)
- **Spec:** Pairing and identity

## Goal

A freshly linked mock engine behaves like Reborn's pending engine: it pairs, the owner registers a passkey, and the signed UI opens on setup (`canDefer: false`). Every heartbeat carries `setup: pending` until the setup completes, then `setup: done`. The dev stack and e2e show the real journey.

## Scope

- A newly linked mock engine starts with onboarding pending and no project (the C-15 seed). An option or env var keeps today's ready-made engine for the scenarios that need one; e2e and `dev:stack` pick deliberately.
- Heartbeat `setup` from the onboarding state; send one at once when setup completes, as after the first passkey.
- Control-listener levers for e2e: settle the device sign-in, fail a harness check.
- Setup state survives a mock-engine restart if the mock already persists its state; otherwise document that it does not.

## Out of scope

- The UI (U-20) and dashboard (D-36).

## Acceptance criteria

- [ ] Tests cover `setup` in heartbeats before and after completion.
- [ ] `bun run dev:stack up` gives a newly linked engine that opens on setup.
- [ ] `bun run check` passes; the e2e `onboarding` scenario passes.
- [ ] **Status** line above set to `done (#<PR>)`.
