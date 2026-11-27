# D-40. Metering and subscription core

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M5
- **Depends on:** D-07
- **Status:** done (#388)
- **Design:** [ADR 0025](../../adr/0025-metering-and-subscriptions.md), extending [ADR 0017](../../adr/0017-billing-entitlements.md), [0021](../../adr/0021-website-license-authority.md) and [0022](../../adr/0022-usage-data-in-d1.md)

## Goal

Billing counts what an organization uses: projects, agents and members (Seb, 2026-11-27). Each count is a meter behind one interface, plans bundle meters into limits and features as configuration, and the rest of the dashboard keeps asking only the entitlements port. This task lays the foundation the upgrade flow, the team view and the platform admin console build on. No payments.

## Scope

- ADR 0025, as its own docs PR (accepted by Seb, 2026-11-27).
- The meter interface and the v1 meters: `projects` (the dashboard's own active engines), `agents` and `members` (the engine's last reported heartbeat counts), `people` (the organization's dashboard members).
- Readings per organization, team and project; unknown counts stay unknown, never zero.
- A daily history in D1 (`usage_daily_meters`), written every 15 minutes beside ADR 0022's rollup, with its retention.
- Plan configuration for meter quotas and `overLimit` (`block` or `warn`); the entitlements port answers them for every billing adapter.
- A limit check that answers `ok`, `warn` or `block` for "one more" of a meter: the hook the upgrade flow calls. Linking asks it for `projects` (`block` keeps D-07's `engine-limit`), invitations for `people` (`block` answers `people-limit`, which the invitation dialog explains); `warn` lets both through.
- `GET /api/usage`, read-only: current readings with their limits.

Out of scope: payments, Stripe changes, the admin console, and any UI beyond the invitation dialog's limit message.

## Acceptance criteria

- [x] ADR 0025 opened as a docs PR and accepted, with its open questions listed for Pavol.
- [x] A new meter is one file, one entry in the closed list and its quota names; no migration or route change.
- [x] Readings cover: no heartbeat yet (unreported, not zero), a revoked or suspended engine (not counted), a team without a project (zero), a project without a team.
- [x] The history job is idempotent and keeps each day's last value and peak.
- [x] Every billing adapter answers the new quotas and `overLimit`; existing plan configuration parses unchanged.
- [x] The limit check: under, at and over the limit, unlimited, unreported counts, `warn` versus `block`.
- [x] Linking and invitations refuse under `block`, proceed under `warn` and under a plan without the quota.
- [x] `GET /api/usage` is declared through the route helper with a permission; members cannot read it.
