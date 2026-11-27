# C-19. Updates contract: see versions, next check and check now

- **Lane:** C · **Module:** `packages/engine-api`, `packages/conformance` · **Milestone:** M5
- **Depends on:** C-10
- **Status:** done (pushed to main)
- **Spec:** Interfaces (draft) 5; Residual risks (2. Engine updates); ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md), [0016](../../adr/0016-engine-capabilities.md)

## Goal

`updates@1`: an owner sees from the browser which versions the project runs, why a UI release waits, when the next check runs, and can run that check early. The engine team can build it from the contract, the reference engine and the conformance checks alone.

## Context

On 2026-11-24 the demo engine (0.119.0-132, staging policy) did not run its periodic UI check for about 15 hours; UI 0.2.5 arrived only after two restarts over SSH. Nothing in the browser showed it, and an owner on a server cannot restart anything. Most of what the owner needs is already in `GET /security` (versions, policy, the last check with `eligibleAt`), so the contract adds to it instead of a second status route.

Decisions (2026-11-24):

- Check-now is the scheduled check run early, never the owner's approval under `manual` (which may skip the delay). Under `manual` it is 409 `update-policy-manual`.
- Permission `settings.manage`, not an owner-only rule: the API decides by permission, and `settings.manage` already covers the stronger control, the policy. No step-up: check-now can install nothing the next scheduled check would not install within the hour.
- A pending release is `ui.lastUpdateCheck` refused with `delay-not-elapsed` and `eligibleAt`; no second field.
- Updating the engine itself stays on the host: the engine reports the command, the UI shows it.

## Scope

- `capabilities/updates.ts`: `KNOWN_CAPABILITIES.updates`; `POST /updates/ui/check` (`checkForUiUpdate`, `settings.manage`) answering `UiUpdateCheck`; `UpdatesChangedEvent { uiVersion }`; `MAX_UI_CHECK_INTERVAL_MS`, `UPDATE_CHECK_MIN_INTERVAL_MS`.
- `GET /security`: `ui.nextCheckAt`, `update.checkedAt`, `update.command` (`MAX_UPDATE_COMMAND_LENGTH`, no control characters), all defaulting to `null`; `UiUpdateCheckReader` for tolerant reads.
- Problem codes `update-policy-manual` (409) and `update-check-too-soon` (429); audit action `updates.ui-check`; additive, so `ENGINE_API_VERSION` stays 1.15.0.
- The in-memory engine: a `UiUpdater` port (policy, next check, check-now) with a fake release store behind levers (`setUiRelease`, `failUiReleaseStore`, `runUiUpdateCheck`, `plugUiUpdater`), the per-engine rate limit and the event.
- Conformance: `engine-api.updates.permissions`, `engine-api.updates.check-now`, `engine-api.updates.next-check-due`, `ui-loader.updates.check-now-respects-delay`, each skipping without the capability and failing against a fake that breaks it (the fake UI lab gained `check-now-skips-delay` and `next-check-far`).
- Docs: [updates.md](../../engine-integration/updates.md), engine-api.md, ui-loader.md, checklist ENG-128 to ENG-130, the AGENT_BRIEF entry of 2026-11-24 with UP-01 to UP-15.

## Out of scope

- The mock engine's loader and levers (M-14) and the UI (U-26).
- Updating the engine from the browser, a restart button, approving a release under `manual` from the browser.

## Acceptance criteria

- [x] Strict in, tolerant out for every new field; refusal tests for the command's shape.
- [x] The in-memory engine refuses check-now under `manual`, within the rate limit and without `settings.manage`, and a release inside its delay is refused with `eligibleAt`.
- [x] The conformance checks pass against the in-memory engine and the fake UI lab, and fail against fakes that break each rule.
- [x] `engine-api` coverage thresholds hold.
- [x] **Status** line above set to `done (pushed to main)`.

## Risks and open points

- `ENGINE_API_VERSION` stays 1.15.0: a bump would make every engine that has not re-vendored refuse the next UI release (`engine-api`). Everything here is additive and defaults to `null` or off without the capability.
- Approving a release by hand under `manual` from the browser (step-up, may skip the delay) is a separate decision.
