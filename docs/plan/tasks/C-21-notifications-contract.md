# C-21. Notifications: heartbeat counts, `notifications@1` and conformance

- **Lane:** C · **Module:** `packages/protocol`, `packages/engine-api`, `packages/conformance` · **Milestone:** M5
- **Depends on:** C-13, C-20
- **Status:** done (#394)
- **Spec:** Interfaces (draft) 4, Metadata we still see; ADRs: [0027](../../adr/0027-notifications.md), [0010](../../adr/0010-protocol-design-principles.md), [0016](../../adr/0016-engine-capabilities.md), [0018](../../adr/0018-teams-and-member-access.md)

## Goal

The engine side of ADR 0027 as a contract: the engine keeps an inbox with content and tells the dashboard only how many unseen items of each kind wait for whom. The engine team can build it from the contract, the reference engine and the conformance checks alone, and the dashboard (D-41) can consume the counts before any engine sends them.

## Scope

- `packages/protocol` (first PR, so D-41 can start): heartbeat v2's optional `attention`, at most `MAX_HEARTBEAT_ATTENTION` (64) `HeartbeatAttention` `{ to?: DashboardUserId, kind: AttentionKind, count: 1..MAX_HEARTBEAT_COUNT }`, one entry per `to` and `kind`; `buildHeartbeatV2` takes `attention` and leaves it out when absent. `HEARTBEAT_MAX_BODY_BYTES` rises to 12 KiB. Additive: no protocol version change, `ENGINE_API_VERSION` stays 1.15.0.
- `packages/engine-api`: capability `notifications@1`. `GET /me/notifications` (the caller's open items with their content, newest first, paged), `GET /me/notifications/unseen` (unseen counts per kind), `POST /me/notifications/seen` (mark up to 100 items seen; another person's or an unknown ID is 404 and marks nothing). `Settings.dashboardAttention` (`null` without the capability) and `PUT /settings/dashboard-attention` (`settings.manage`, step-up), audited. Tolerant readers for unknown kinds and link targets. The in-memory engine implements it, with levers to raise and close items and to read the `attention` entries it would send.
- `packages/conformance`: engine API checks for the routes (own items only, mark-seen lowers the count, project-wide items only for managers, the switch and its permission, strict bodies) and a platform `notifications` suite over heartbeats: `attention` names only dashboard users with an approved ticket on that engine, stays within the caps and is absent while switched off.
- Docs: heartbeat.md, engine-api.md, the spec's heartbeat and metadata tables, the checklist and the AGENT_BRIEF entry for the engine team.

## Decisions (2026-11-27)

- **On by default, off in strict mode** (Seb, as ADR 0027): the owner switches it off in the engine's settings, and the engine UI shows which it is.
- **No engine content can reach app.ptbk.io** (Seb). `HeartbeatAttention` is a strict object of `to`, `kind` and `count` only: no item text, titles, names, item IDs or URLs fit, and unknown fields fail the whole heartbeat. Conformance asserts that every `attention` entry carries only those keys and that the heartbeat body holds none of the items' text or IDs. Item content travels only between the engine and its own UI.
- **12 KiB, not ADR 0027's 8 KiB.** 64 entries beside 32 acks fit 8 KiB only with the dashboard's own 26- and 43-character IDs; with every ID at the 64 characters the schema allows the body is about 10.9 KB. The cap must hold for every valid body.
- **One entry per `to` and `kind`.** The dashboard keeps one row per person, project and kind; two entries would make the count ambiguous, so the schema refuses them.
- **Present but empty while on.** `attention: []` says the owner shares counts and nothing waits; absent says the owner switched it off.
- **Project-wide items** are for members holding `settings.manage`, and one of them seeing an item marks it seen for all, since the dashboard gets one count for the project's managers.

## Out of scope

- The mock engine (M-16), the engine UI (U-29) and the dashboard (D-41).

## Acceptance criteria

- [x] Strict in, tolerant out: refusal tests for 65 entries, unknown kinds, zero, fractional and oversized counts, recipients that are not IDs, duplicates, text in an entry, `attention` in v1.
- [x] The largest valid v2 body fits `HEARTBEAT_MAX_BODY_BYTES`.
- [x] `protocol`, `engine-api` and `conformance` coverage thresholds of 90% hold.
- [x] Every notifications check fails against a fake that breaks its rule and skips against an engine without the capability.
- [x] **Status** line above set to `done (#<PR>)`.
