# R-07. Relay tunnel presence for the dashboard

- **Lane:** R · **Module:** `apps/relay` and `apps/dashboard` (two modules, see Context) · **Milestone:** M3
- **Depends on:** D-04, D-05, R-03
- **Status:** todo
- **Spec:** Metadata we still see; Relay and tunnel; Operations; ADRs: [0005](../../adr/0005-modular-architecture.md); design: [onboarding.md](../../design/onboarding.md) (What each side can observe)

## Goal

The dashboard knows how many relays currently hold a ready tunnel for each engine, so it can tell "online and reachable" from "online but not reachable" (heartbeats arrive directly, tunnels may still fail behind a proxy), without any change to the engine.

## Context

Heartbeats go straight from the engine to the dashboard, so "Online" today says nothing about whether browsers can reach the engine. Relays know their tunnels. Decided 2026-10-26 (E-05): no engine contract change; the relays report presence instead. Like D-04, the endpoint and its only client must change together, so this task touches the relay and the dashboard, in separate commits.

Presence is a subset of metadata the spec already lists ("Engine IP, tunnel connect and disconnect times", relay, 7 days): it carries no IP and no times beyond "now".

## Scope

- Dashboard: `PUT /internal/v1/relays/presence` (relay-token auth from D-04, `permission: null`, per-relay rate limit), body `{ v: 1, engineIds: EngineId[] }` (strict, at most a configured cap, the relay ID taken from the token, never the body). Stores per engine ID the set of relay IDs and when each last reported, in the engine's `EngineStatus` Durable Object or a D1 table, whichever keeps `GET /api/engines` within D-06's fan-out budget. An entry expires 3 minutes after its relay's last report.
- `EngineStatus` snapshots gain `reachableRelays: number | null` (`null` when no relay has reported since the dashboard started); D-06's list and detail show "Reachable through {n} relays" or "Not reachable: no relay connection" for an online engine.
- Relay: every 60 s, and within 5 s of a tunnel becoming ready or closing (debounced), send the full list of engine IDs with a ready tunnel. A failed report is logged with its status only and retried at the next tick; it never affects routing.
- Schema for the body in the dashboard's `src/shared/api/` and the relay's adapter; not in `@ptbk/protocol` (relay and dashboard are both ours; nothing engine-facing changes).

## Out of scope

- Showing presence on D-10's checklist (D-10 renders it when the field is present). Relay metrics (I-04).

## Design notes

- Full-list reports, not deltas, so a lost report heals at the next tick and a restarted relay never leaves stale "reachable" entries beyond the expiry.
- No history is kept; nothing in the report links to browsers or traffic.

## Acceptance criteria

- [ ] Dashboard Workers tests: a report updates presence; an entry expires after 3 minutes; an unknown field → 400; a missing or revoked token → 401; the relay ID comes from the token; over the cap → 413.
- [ ] Relay tests with a fake clock and a fake dashboard: periodic and debounced reports, the full list each time, failures do not affect tunnels.
- [ ] Client tests: the list and the detail show both reachable texts, and nothing when `reachableRelays` is `null`.
- [ ] `bun run check` passes; the e2e suite still passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- With many engines per relay, the report size grows linearly; the cap and a split into pages are a later concern (R-05's numbers).
