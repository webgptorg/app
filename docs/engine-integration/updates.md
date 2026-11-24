# Updates from the browser (`updates@1`)

What an owner sees and does about updates in our UI: which versions the project runs, why a UI release waits, when the next check runs, and "Check now". Updating the engine itself stays on the host: the UI shows the command, never runs it.

Contract: [`capabilities/updates.ts`](../../packages/engine-api/src/capabilities/updates.ts) and the `updates@1` fields of `GET /security` in [`security.ts`](../../packages/engine-api/src/security.ts). Additive under engine API 1.15.0. Related: [ui-loader.md](ui-loader.md) (the check itself), [installation.md](installation.md#upgrades) (how the engine is updated).

## Why

On 2026-11-24 the demo engine (0.119.0-132, staging policy) did not run its periodic UI check for about 15 hours. UI 0.2.5 arrived only after two restarts over SSH. Nobody could see that from the browser, and an owner on a server has no way to restart anything. The owner needs to see a check that is late and to run it.

## What the engine reports

Everything is in `GET /security` (`security.read`), next to what it already reports. An engine without the capability sends none of these fields; they read as `null`.

| Field                | Meaning                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `engine.version`     | The running engine (unchanged).                                                                                                                                                                                                            |
| `update.*`           | The engine's own update: `status`, `availableVersion` (the newest published version, when newer), `eligibleAt` and the policy (unchanged).                                                                                                 |
| `update.checkedAt`   | When the engine last learned which engine version is the newest published one. `null` when it does not look.                                                                                                                               |
| `update.command`     | The one shell line that updates the engine the way it was installed, for example `npm install --global ptbk@0.120.0` for the npm package. At most `MAX_UPDATE_COMMAND_LENGTH` (512) characters, no control characters. `null` when unsure. |
| `ui.version`, …      | The served UI bundle (unchanged).                                                                                                                                                                                                          |
| `ui.lastUpdateCheck` | The last UI check, scheduled or asked for (unchanged). A release waiting on its delay is `refused` with `delay-not-elapsed` and `eligibleAt`. This is the "pending release": there is no second field for it.                              |
| `ui.nextCheckAt`     | When the next scheduled UI check is due: at most `MAX_UI_CHECK_INTERVAL_MS` (1 hour) after the last check, or the extra check at a delayed release's `eligibleAt` if that is sooner. `null` under `manual` and while the loader is off.    |

Compute `nextCheckAt` from the timer you actually armed, not from a formula. A `nextCheckAt` in the past then shows that the timer did not fire, which is exactly what went wrong on 2026-11-24. The UI says "Late: it was due …" and offers "Check now".

`update.command` is shown as text to copy. Never put anything in it that the owner should not run, and never a secret.

## Check now

`POST /updates/ui/check` (`checkForUiUpdate`), permission `settings.manage`, no body. It runs the UI loader's normal check now instead of at `nextCheckAt`, and answers 200 with the check's result as a `UiUpdateCheck` once the check has ended and `GET /security` reports it as `ui.lastUpdateCheck`.

- **Nothing is skipped.** It is the same check the timer runs: the same policy, `verifyRelease` with the same inputs, the delay, the revocation list, no downgrade, the archive and manifest checks. In particular it passes `mode: 'manual'` only where the timer does (under `pinned`), never because a person asked. A release inside its delay is `refused` with `delay-not-elapsed` and its `eligibleAt`.
- **Under `manual`:** 409 `update-policy-manual`. Nothing is scheduled there, and approving a release by hand (which may skip the delay) is a separate decision that this route must not become.
- **One at a time.** A check already running is joined: answer its result instead of starting a second one.
- **Rate limit:** at most one accepted request per engine every `UPDATE_CHECK_MIN_INTERVAL_MS` (60 s), whoever asks; earlier is 429 `update-check-too-soon`. Scheduled checks do not count. A refused request runs nothing.
- **Afterwards:** the extra check at `eligibleAt` follows the usual rule: every check cancels the pending one, a new delay refusal schedules it again ([ui-loader.md](ui-loader.md#what-the-engine-must-do)). The periodic timer is not reset.
- **Audit:** `updates.ui-check`, with the outcome of the request (the check's own result is in `GET /security`, not in the audit entry).

**Why `settings.manage`, not owner-only.** The API decides by permission, never by role, and `settings.manage` already covers the update policy, which is the stronger control. Check-now cannot install anything that the next scheduled check would not install within the hour, so it needs no step-up. Engines give `settings.manage` to owners and, if they choose, admins.

## Event

`updates.changed { uiVersion }` after every UI check, scheduled or asked for, and whenever the served bundle changes. `uiVersion` is the bundle served from now on (`null` while none is). Send it to every member who can open the event stream: the served UI version is no secret to anyone who loads the page, and the check details stay behind `security.read`. A page built as another version offers "Reload to use version …"; it never reloads by itself.

## Test cases

The engine's own tests, with a fake clock wherever time matters:

| ID    | Case                                                                                                                                                | Expected                                                                                                                                                           |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| UP-01 | Start under `auto`; let the fake clock pass one interval, then another                                                                              | A check at start and after each interval; `nextCheckAt` is start + interval, then moves on after each check                                                        |
| UP-02 | A check throws (store down, disk error, a bug in the check)                                                                                         | The next periodic check is still armed and runs; `nextCheckAt` is set                                                                                              |
| UP-03 | A release is refused with `delay-not-elapsed`, eligible in 10 minutes                                                                               | `nextCheckAt` is `eligibleAt` plus jitter; at that time the check runs and installs; the periodic check still runs afterwards                                      |
| UP-04 | As UP-03, but the process sleeps (laptop lid, VM paused) past both times                                                                            | On waking, a check runs within a minute; `nextCheckAt` never stays in the past for more than one check                                                             |
| UP-05 | `POST /updates/ui/check` under `auto` while a release waits on its delay                                                                            | 200 `refused` `delay-not-elapsed` with the same `eligibleAt`; the active bundle is unchanged; nothing installs                                                     |
| UP-06 | `POST /updates/ui/check` under `pinned` to a valid version                                                                                          | Installs it like the scheduled check would; `updates.changed` carries the new version                                                                              |
| UP-07 | `POST /updates/ui/check` under `manual`                                                                                                             | 409 `update-policy-manual`; no check runs                                                                                                                          |
| UP-08 | Two requests within 60 s, from two members                                                                                                          | The first runs a check, the second is 429 `update-check-too-soon`; after 60 s one is accepted again; scheduled checks in between do not count                      |
| UP-09 | A request while a scheduled check is running                                                                                                        | Joins it: one check, both answered with its result                                                                                                                 |
| UP-10 | A member without `settings.manage`                                                                                                                  | 403 `forbidden`; no check runs; the refusal is audited as `denied`                                                                                                 |
| UP-11 | A revoked release, a signature outside the policy, a release missing from the log, an older version, a hash mismatch, each asked for with check-now | Refused with the same reason the scheduled check gives; the active bundle stays                                                                                    |
| UP-12 | `GET /security` after every case above                                                                                                              | `ui.lastUpdateCheck` is the latest check; `ui.nextCheckAt` is at most an hour after it (`null` only under `manual` or with the loader off)                         |
| UP-13 | Every check, scheduled or asked for                                                                                                                 | One `updates.changed` with the served `uiVersion`, to every member on the stream                                                                                   |
| UP-14 | `update.command` and `update.checkedAt` for each way the engine is installed (npm package, the VPS installer, Docker)                               | The command updates that installation when run as printed; `null` where you cannot tell; never a line break, a secret or a path from the request                   |
| UP-15 | By hand: the demo server under the staging policy, a new UI release published                                                                       | Within 5 minutes plus one interval the release installs with no restart; "Check now" in Settings shows it waiting, then installed, and the open page offers reload |

## Conformance

| Check                                        | What it proves                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `engine-api.updates.permissions`             | Without `settings.manage`, 403 and no check runs                                                                                                                         |
| `engine-api.updates.check-now`               | A check-now is reported in `GET /security`; a second within a minute is 429 `update-check-too-soon`; under `manual`, 409 `update-policy-manual` and nothing scheduled    |
| `engine-api.updates.next-check-due`          | `ui.nextCheckAt` is at most an hour after the last check and not long past                                                                                               |
| `ui-loader.updates.check-now-respects-delay` | With a release inside its 72 h delay, check-now answers `refused` `delay-not-elapsed` with `eligibleAt`, the current bundle stays, and the next check is within the hour |

Each skips when the engine does not advertise `updates@1`. The reference implementation is the in-memory engine (a fake release store) and the mock engine (its real loader, or the fake store with levers, [mock-engine.md](mock-engine.md)).
