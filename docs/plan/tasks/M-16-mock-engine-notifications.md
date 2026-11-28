# M-16. Mock engine: notifications inbox and heartbeat attention

- **Lane:** M · **Module:** `apps/mock-engine` (and the mock target in `packages/conformance`) · **Milestone:** M5
- **Depends on:** C-21
- **Status:** done (#395)
- **Spec:** Interfaces (draft) 4; ADRs [0027](../../adr/0027-notifications.md), [0004](../../adr/0004-mock-engine-and-conformance.md)

## Goal

The mock engine serves `notifications@1` with fake data and sends the counts in its heartbeats exactly as C-21 specifies, so the engine UI (U-29) and the dashboard (D-41) work end to end before the real engine has it, and the conformance suite proves the reference.

## Scope

- `notifications` in the mock's capabilities (the `full` profile; not `reborn`, which mirrors what the real engine has).
- Fake inbox per person: each seeded member gets deterministic items with their content and links (an agent waiting in a chat, a failed task), and the project an AI tool sign-in item, all from the core's `raiseNotification`.
- Heartbeat v2 carries `attention` from the core's unseen items (`controller.attention()`), and leaves it out while the owner's switch is off.
- The owner's switch: on by default, `PTBK_DASHBOARD_ATTENTION=off` starts it off (strict mode starts it off on a real engine). Changed in the browser through `PUT /settings/dashboard-attention`.
- Control listener: `POST /__mock/notifications` raises an item, `POST /__mock/notifications/close` closes one; the conformance mock target's `notifications.raise` lever uses it.

## Decisions (2026-11-27)

- **No engine content in the heartbeat** (Seb): the mock builds `attention` only with `buildHeartbeatV2`, which copies `to`, `kind` and `count`; a test asserts the body never holds an item's title, detail or ID.

## Acceptance criteria

- [x] Unit tests: attention in v2 beats and absent while off, no content in the body, the switch's default from the environment, the control routes.
- [x] The `engine-api` and `notifications` conformance suites pass against the mock engine.
- [x] **Status** line above set to `done (#<PR>)`.
