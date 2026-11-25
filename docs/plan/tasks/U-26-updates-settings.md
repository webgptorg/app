# U-26. Engine UI: updates in Settings

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M5
- **Depends on:** C-19
- **Status:** done (pushed to main)
- **Spec:** Interfaces (draft) 5; ADRs: [0015](../../adr/0015-ui-architecture-and-design-system.md), [0016](../../adr/0016-engine-capabilities.md)

## Goal

Settings → Updates says, in plain words, which versions the project runs, why an update waits and when the next check runs, and lets those with `settings.manage` run the check now. An open page offers a reload once the project serves a newer app.

## Context

Settings already holds the engine version and the update policy (the brief's "what you change"), and the Security page shows the verification details. The new rows go next to the policy rather than into the trust panel: they are about what happens next, not about evidence. No new route, so nothing new to lazy-load.

## Scope

- In the Updates section: the app version with a reload button when the project serves another; the last check with the reason in words (waiting until a time and why releases wait, refused and why, store unreachable); the next check, or "Late: it was due …", or under `manual` that only an owner's approval installs; "Check now" with `updates@1`, `settings.manage` and a policy other than `manual`, with a toast for every outcome and for 429.
- The engine's update command as copyable text when the engine reports a newer version, with the note that the project cannot update itself from the browser.
- A reload banner on every page after `updates.changed` names another version than this page's; it never reloads by itself and can be dismissed.
- The audit label for `updates.ui-check`; English and Czech messages.

## Out of scope

- Updating the engine or restarting it from the browser; approving a release under `manual`.

## Acceptance criteria

- [x] Tests cover check-now with a waiting release, the 429 toast, an unreachable store, no button under `manual` or without `settings.manage`, the command and reload rows, and the banner from an event; axe passes.
- [x] **Status** line above set to `done (pushed to main)`.
