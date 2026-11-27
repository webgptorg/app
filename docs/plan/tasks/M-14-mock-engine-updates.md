# M-14. Mock engine: updates from the browser

- **Lane:** M · **Module:** `apps/mock-engine` · **Milestone:** M5
- **Depends on:** C-19, M-05
- **Status:** done (pushed to main)
- **Spec:** Interfaces (draft) 5; ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md)

## Goal

The mock engine speaks `updates@1` (C-19) as the reference for the engine team: its real UI loader behind check-now and `nextCheckAt`, and deterministic levers for local development without a release store.

## Scope

- `updates` in the mock's capabilities (`full` profile, or `MOCK_CAPABILITIES`).
- The UI updater reports the timer it armed (`nextCheckAtMs`: the periodic check or the extra one at `eligibleAt`) and joins a running check on check-now (`checkEarly`); the loader plugs into the core as its `UiUpdater`. Check-now never takes the `manual` approval path.
- `updates.changed` after every loader check, with the served version.
- Without `PTBK_UI_RELEASE_URL`, the core's fake release store answers, and the security panel's `ui` is left to it after start.
- Control levers: `PUT /__mock/updates` (`uiRelease` with `delayS`, `uiStoreFailing`, `engineLatest`) and `POST /__mock/updates/check`, both deterministic on the engine's clock.
- Docs: the mock engine's README and [mock-engine.md](../../engine-integration/mock-engine.md).

## Out of scope

- The UI (U-26), the dev stack and e2e scenarios.

## Acceptance criteria

- [x] Tests cover the next check (start, interval, `eligibleAt`, `manual`, stopped), joining a running check, the event, the plugged updater across a reset, and the levers.
- [x] The client suite, including check-now, passes through the mock engine.
- [x] **Status** line above set to `done (pushed to main)`.
