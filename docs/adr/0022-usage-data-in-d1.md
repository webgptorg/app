# 0022. Usage data in D1, without engine content

- **Status:** Accepted
- **Decided by:** Seb, 2026-11-20
- **Date:** 2026-11-20

## Context

We cannot see how the product is used: how many sign-ups get an engine running, where they stop, how many engines and people are active, which engine versions are out there ([#328](https://github.com/webgptorg/app/issues/328)). The dashboard already holds the metadata to answer that: accounts, organizations, link codes, registrations, heartbeats, invitations and access tickets.

Two rules bound it. The dashboard stores no engine content (AGENTS.md rule 2), and nothing it keeps may hold secrets or personal data beyond what it needs (rule 8, spec Metadata we still see). Monitoring already writes aggregates to Workers Analytics Engine ([ADR 0012](0012-monitoring-backend.md)), but those carry no engine or account IDs by design ([engineering.md](../engineering.md)).

For now we only collect well-structured data to improve the product. A superadmin dashboard comes later; the tables should make it easy, but no UI is built now.

## Decision

**Usage data lives in the dashboard's D1 database**, in three tables (migration `0014_usage_data`).

`usage_events` is append-only: `id`, `occurred_at` (ms), `event`, `org_id`, `user_id` (nullable), `engine_id` (nullable), `props` (JSON). The events are a closed list (`apps/dashboard/src/domain/usage/usage-event.ts`):

| Event                    | Props                                        | Recorded when                                                                                   |
| ------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `account.signed_up`      | `via`: `signup` \| `invite`                  | Signup verified (`POST /api/auth/signup/verify`), or a new account joins through an invitation  |
| `org.created`            | `kind`: `personal` \| `team`                 | Signup verified (its personal organization)                                                     |
| `engine.created`         | `forTeam`: boolean                           | A link code is issued, from New engine or for a team                                            |
| `engine.linked`          | `mode`: `tunnel` \| `direct`, `relinked`     | A registration is accepted (`POST /v1/engines/register`)                                        |
| `engine.first_heartbeat` | `setup`: `pending` \| `done` \| `unreported` | The engine's status object accepts its first heartbeat ever                                     |
| `engine.setup_completed` | none                                         | The heartbeat's `setup` goes from `pending` to `done`, or is `done` in the first heartbeat      |
| `engine.removed`         | `via`: `revoked` \| `team-deleted`           | The owner revokes the engine, or deletes its team                                               |
| `invite.sent`            | `role`, `teams` (a count)                    | One per invitation emailed                                                                      |
| `invite.accepted`        | `as`: `new-account` \| `existing-account`    | An invitation is accepted                                                                       |
| `access.requested`       | none                                         | A team member opens the team's engine without access, and the dashboard issues an access ticket |
| `access.approved`        | none                                         | The engine acks the ticket as approved in a v2 heartbeat                                        |
| `access.declined`        | none                                         | The engine acks it as declined                                                                  |

**Privacy.** Props are numbers, booleans and closed enums only, and each event is parsed with a strict schema before every write; an event that fails is dropped with a log line (`usage.event-refused`). Subjects are IDs the dashboard already has: organization, user and engine. No names, emails, IP addresses, user agents, tokens, and nothing from inside the engine beyond what the heartbeat already carries.

**Best effort.** The recorder never rejects. HTTP handlers hand it to the request's `waitUntil`, so no response waits on it; the status object awaits its two milestone writes, which a failure cannot break. A failed write logs `usage.record-failed` (error name, event count) and the events are lost. A lost event skews a count; a failed sign-up because of analytics would be worse.

**No write per heartbeat.** The engine's `EngineStatus` Durable Object counts beats inside the status it already saves on every heartbeat, for the current and the previous UTC day. It writes to D1 only for the two milestones, which happen once or twice in an engine's life.

**Daily rollups.** The `usage-rollup` job runs on the existing `*/15 * * * *` cron and needs only D1 and the status objects:

- `usage_daily_engines`: one row per engine and UTC day it sent a heartbeat. `beats` (accepted heartbeats, one a minute, so also online minutes), the first and last beat's time, and the last heartbeat's `engine_version`, `agents`, `members`, `setup`, `update_state` and `cpu_load`. Read from each active engine's status object.
- `usage_daily_people`: `(day, org_id, user_id)` for everyone whose session was used that day (`sessions.last_seen_at`, written at most once a minute), in the session's active organization.

Each run writes today's and yesterday's rows again, so runs are idempotent and the first run after midnight completes the day before. Days are `YYYY-MM-DD` in UTC.

**Retention**, enforced by the same job: events 13 months, so a year can be compared with the one before; rollups 25 months. Deleting an account sets `usage_events.user_id` to null (the event stays, anonymous) and deletes its `usage_daily_people` rows; deleting an organization deletes its rows in all three tables. These are foreign keys, so a future deletion path cleans up usage data without extra code.

Queries for the funnel and activity are in [docs/runbooks/usage-queries.md](../runbooks/usage-queries.md).

## Alternatives considered

- **Workers Analytics Engine** (the `OPS_METRICS` dataset): no new storage, but it keeps data three months and samples at volume, so counts are estimates. Its labels must stay low-cardinality, and engineering.md forbids engine and account IDs as metric labels. It cannot join with accounts or engines, so a funnel per organization is impossible. D1 gives exact counts, joins, our own retention, deletion with the account, and plain SQL for the superadmin dashboard.
- **Upserting a D1 row on every heartbeat**: simpler, but one D1 write per engine per minute, for numbers the status object already holds. The rollup costs one batch every 15 minutes instead.
- **A separate analytics service** (PostHog, a warehouse): a new sub-processor for the privacy policy, a second copy of account data to keep in step and delete, and more to run, for questions SQL on D1 answers today.

## Consequences

- Funnel, activity, invitations and engine versions are a SQL query away, and the superadmin dashboard can read the same tables.
- Writes stay small: a handful per sign-up or engine, one batch every 15 minutes, none per heartbeat.
- Every new event is a code change: an entry in the closed list with its props schema, reviewed against rules 2 and 8. The table has no CHECK on `event`, so adding one needs no migration.
- The rollup asks every active engine's status object, 10 at a time, every 15 minutes. That is fine for hundreds to low thousands of engines; past that, the objects should push their finished day instead.
- People are counted by their session's last use. Someone active only in the last minutes before midnight who returns before the next run counts on the later day only, and a person counts in their session's active organization only.
- Outside dev, the scheduled run still refuses to start without `MONITORING` or the email binding, so the rollup runs only where monitoring is configured.
- Anything more from inside the engine (usage of agents, chats, models) needs aggregates the heartbeat does not carry. That is an opt-in heartbeat contract change agreed with the engine team, not a dashboard change.
