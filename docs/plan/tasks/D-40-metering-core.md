# D-40. Metering and subscription core

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M5
- **Depends on:** D-07, D-30
- **Status:** in progress (docs/d-39-metering-adr)
- **Design:** [ADR 0025](../../adr/0025-metering-and-subscriptions.md), extending [ADR 0017](../../adr/0017-billing-entitlements.md), [0021](../../adr/0021-website-license-authority.md) and [0022](../../adr/0022-usage-data-in-d1.md)

## Goal

Billing counts what an organization uses: projects, agents and members (Seb, 2026-11-27). Each count is a meter behind one interface, plans bundle meters into limits and features as configuration, and the rest of the dashboard keeps asking only the entitlements port. This task lays the foundation the upgrade flow, the team view and the platform admin console build on. No payments.

## Scope

- ADR 0025 (Proposed), as its own docs PR.
- The meter interface and the v1 meters: `projects` (the dashboard's own active engines), `agents` and `members` (the engine's last reported heartbeat counts), `people` (the organization's dashboard members).
- Readings per organization, team and project; unknown counts stay unknown, never zero.
- A daily history in D1 (`usage_daily_meters`), written by the existing `usage-rollup` job, with ADR 0022's retention.
- Plan configuration for meter quotas and `overLimit` (`block` or `warn`); the entitlements port answers them for every billing adapter.
- A limit check that answers `ok`, `warn` or `block` for "one more" of a meter: the hook the upgrade flow calls.
- `GET /api/usage`, read-only: current readings with their limits.

Out of scope: payments, Stripe changes, the admin console, any UI, and wiring the limit check into linking and invitations (those routes are being changed for ADR 0023; a follow-up wires it once that lands).

## Acceptance criteria

- [ ] ADR 0025 opened as a docs PR, with the two open decisions marked for Seb.
- [ ] A new meter is one file and one entry in the closed list; no migration, route or plan-schema change.
- [ ] Readings cover: no heartbeat yet (unreported, not zero), a revoked or suspended engine (not counted), a team without a project (zero), a project without a team.
- [ ] The history job is idempotent and keeps each day's last value and peak.
- [ ] Every billing adapter answers the new quotas and `overLimit`; existing plan configuration parses unchanged.
- [ ] The limit check: under, at and over the limit, unlimited, unreported counts, `warn` versus `block`.
- [ ] `GET /api/usage` is declared through the route helper with a permission; members cannot read it.
