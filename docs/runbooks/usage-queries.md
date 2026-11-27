# Usage data: queries

How to read the product's usage data ([ADR 0022](../adr/0022-usage-data-in-d1.md)): the funnel from sign-up to a set-up engine, active engines and people, invitations and access requests. It is IDs, counts and closed enums in the dashboard's D1 database; there is no UI for it yet.

## Where it is

| Table                 | One row per                                   | Written by                                           | Kept      |
| --------------------- | --------------------------------------------- | ---------------------------------------------------- | --------- |
| `usage_events`        | event (`event`, `occurred_at` in ms, `props`) | the request or heartbeat that caused it              | 13 months |
| `usage_daily_engines` | engine and UTC day it sent a heartbeat        | the `usage-rollup` job, every 15 minutes             | 25 months |
| `usage_daily_people`  | person, organization and UTC day they were in | the `usage-rollup` job, from `sessions.last_seen_at` | 25 months |

Days are `TEXT` `'YYYY-MM-DD'` in UTC and sort as they read. Times are milliseconds since the epoch: `datetime(occurred_at / 1000, 'unixepoch')`. `props` is JSON: `json_extract(props, '$.setup')`. The events and their props are listed in the ADR and in `apps/dashboard/src/domain/usage/usage-event.ts`.

Today's rollup rows grow until the day ends; yesterday's are complete after the first run past midnight UTC. `usage_daily_engines.beats` counts accepted heartbeats, one a minute, so `beats / 60.0` is hours online.

## Running a query

From `apps/dashboard`, logged in with `bunx wrangler login`. `DB` is the binding; `--env` picks the database from `wrangler.jsonc`: `staging` (`ptbk-dashboard-staging`, serves app.ptbk.io today) or `production` (`ptbk-dashboard-production`, not created yet: its `database_id` is still a placeholder). Every query below is one command; the quoted heredoc keeps the shell away from `$` and quotes in the SQL.

```sh
cd apps/dashboard
bunx wrangler d1 execute DB --env staging --remote --command "SELECT event, COUNT(*) AS events FROM usage_events GROUP BY event ORDER BY event"
```

Add `--json` to get the rows as JSON instead of a table. The queries only read; there is never a reason to write these tables by hand.

## Funnel by week of sign-up

Each organization's first time at each step, grouped by the Monday of the week it signed up. A sign-up is `org.created`, which only email-first signup emits; people who join through an invitation land in an existing organization and are counted under invitations below. An organization that signed up more than 13 months ago has lost its events and drops out.

```sh
bunx wrangler d1 execute DB --env staging --remote --command "$(cat <<'SQL'
WITH firsts AS (
  SELECT org_id,
    MIN(CASE WHEN event = 'org.created' THEN occurred_at END) AS signed_up,
    MIN(CASE WHEN event = 'engine.created' THEN occurred_at END) AS created,
    MIN(CASE WHEN event = 'engine.linked' THEN occurred_at END) AS linked,
    MIN(CASE WHEN event = 'engine.first_heartbeat' THEN occurred_at END) AS first_heartbeat,
    MIN(CASE WHEN event = 'engine.setup_completed' THEN occurred_at END) AS setup_completed
  FROM usage_events
  GROUP BY org_id
)
SELECT date(signed_up / 1000, 'unixepoch', 'weekday 0', '-6 days') AS week,
  COUNT(*) AS signed_up,
  COUNT(created) AS created_engine,
  COUNT(linked) AS linked,
  COUNT(first_heartbeat) AS first_heartbeat,
  COUNT(setup_completed) AS setup_completed
FROM firsts
WHERE signed_up IS NOT NULL
GROUP BY week
ORDER BY week
SQL
)"
```

## Active engines per day and week

An engine is active on a day it sent at least one accepted heartbeat. Last 30 days, then weeks (Monday) of the last 12:

```sh
bunx wrangler d1 execute DB --env staging --remote --command "$(cat <<'SQL'
SELECT day,
  COUNT(*) AS active_engines,
  COUNT(DISTINCT org_id) AS organizations,
  ROUND(SUM(beats) / 60.0, 1) AS hours_online
FROM usage_daily_engines
WHERE day >= date('now', '-30 days')
GROUP BY day
ORDER BY day
SQL
)"
```

```sh
bunx wrangler d1 execute DB --env staging --remote --command "$(cat <<'SQL'
SELECT date(day, 'weekday 0', '-6 days') AS week,
  COUNT(DISTINCT engine_id) AS active_engines,
  COUNT(DISTINCT org_id) AS organizations
FROM usage_daily_engines
WHERE day >= date('now', '-84 days')
GROUP BY week
ORDER BY week
SQL
)"
```

## Active people per day and week

A person is active on a day a session of theirs was used, at most once a minute. They count once however many organizations they were in; the `organizations` column counts organizations with anyone active.

```sh
bunx wrangler d1 execute DB --env staging --remote --command "$(cat <<'SQL'
SELECT day,
  COUNT(DISTINCT user_id) AS active_people,
  COUNT(DISTINCT org_id) AS organizations
FROM usage_daily_people
WHERE day >= date('now', '-30 days')
GROUP BY day
ORDER BY day
SQL
)"
```

```sh
bunx wrangler d1 execute DB --env staging --remote --command "$(cat <<'SQL'
SELECT date(day, 'weekday 0', '-6 days') AS week,
  COUNT(DISTINCT user_id) AS active_people,
  COUNT(DISTINCT org_id) AS organizations
FROM usage_daily_people
WHERE day >= date('now', '-84 days')
GROUP BY week
ORDER BY week
SQL
)"
```

## Setup completion

Of the engines that sent a first heartbeat, how many finished browser setup. Engines whose heartbeat reports no `setup` (built before onboarding@1) cannot complete it and are left out of the rate.

```sh
bunx wrangler d1 execute DB --env staging --remote --command "$(cat <<'SQL'
WITH engines AS (
  SELECT engine_id,
    MIN(CASE WHEN event = 'engine.first_heartbeat' THEN json_extract(props, '$.setup') END) AS first_setup,
    MAX(event = 'engine.setup_completed') AS completed
  FROM usage_events
  WHERE event IN ('engine.first_heartbeat', 'engine.setup_completed')
  GROUP BY engine_id
  HAVING first_setup IS NOT NULL
)
SELECT COUNT(*) AS first_heartbeats,
  SUM(first_setup = 'unreported') AS without_setup,
  SUM(first_setup = 'done') AS done_at_first_heartbeat,
  SUM(completed) AS setup_completed,
  ROUND(100.0 * SUM(completed) / NULLIF(SUM(first_setup != 'unreported'), 0), 1) AS completion_percent
FROM engines
SQL
)"
```

## Time from sign-up to first heartbeat

Minutes from an organization's `org.created` to its first engine's first heartbeat, for organizations that got there. SQLite has no percentile function, so the median and the 90th percentile are the first values whose cumulative share reaches 50 % and 90 %.

```sh
bunx wrangler d1 execute DB --env staging --remote --command "$(cat <<'SQL'
WITH per_org AS (
  SELECT org_id,
    MIN(CASE WHEN event = 'org.created' THEN occurred_at END) AS signed_up,
    MIN(CASE WHEN event = 'engine.first_heartbeat' THEN occurred_at END) AS first_heartbeat
  FROM usage_events
  WHERE event IN ('org.created', 'engine.first_heartbeat')
  GROUP BY org_id
),
waits AS (
  SELECT (first_heartbeat - signed_up) / 60000.0 AS minutes,
    CUME_DIST() OVER (ORDER BY first_heartbeat - signed_up) AS share
  FROM per_org
  WHERE signed_up IS NOT NULL AND first_heartbeat IS NOT NULL
)
SELECT COUNT(*) AS organizations,
  ROUND(MIN(CASE WHEN share >= 0.5 THEN minutes END), 1) AS median_minutes,
  ROUND(MIN(CASE WHEN share >= 0.9 THEN minutes END), 1) AS p90_minutes,
  ROUND(MAX(minutes), 1) AS max_minutes
FROM waits
SQL
)"
```

The same waits as a distribution, which says more while there are few organizations:

```sh
bunx wrangler d1 execute DB --env staging --remote --command "$(cat <<'SQL'
WITH per_org AS (
  SELECT org_id,
    MIN(CASE WHEN event = 'org.created' THEN occurred_at END) AS signed_up,
    MIN(CASE WHEN event = 'engine.first_heartbeat' THEN occurred_at END) AS first_heartbeat
  FROM usage_events
  WHERE event IN ('org.created', 'engine.first_heartbeat')
  GROUP BY org_id
)
SELECT CASE
    WHEN first_heartbeat IS NULL THEN '6 not yet'
    WHEN first_heartbeat - signed_up < 600000 THEN '1 under 10 minutes'
    WHEN first_heartbeat - signed_up < 3600000 THEN '2 under an hour'
    WHEN first_heartbeat - signed_up < 86400000 THEN '3 under a day'
    WHEN first_heartbeat - signed_up < 604800000 THEN '4 under a week'
    ELSE '5 a week or more'
  END AS bucket,
  COUNT(*) AS organizations
FROM per_org
WHERE signed_up IS NOT NULL
GROUP BY bucket
ORDER BY bucket
SQL
)"
```

## Invitations and access requests

Per month. Events carry no invitation ID, so this compares counts, not individual invitations: an invitation accepted in the month after it was sent counts in each month once. `invite.accepted` also counts people who accepted on an existing account; `new_accounts` are those who signed up through it. An access request and its answer share `user_id` and `engine_id`, if you need to pair them.

```sh
bunx wrangler d1 execute DB --env staging --remote --command "$(cat <<'SQL'
SELECT strftime('%Y-%m', occurred_at / 1000, 'unixepoch') AS month,
  SUM(event = 'invite.sent') AS invites_sent,
  SUM(event = 'invite.accepted') AS invites_accepted,
  SUM(event = 'invite.accepted' AND json_extract(props, '$.as') = 'new-account') AS new_accounts,
  SUM(event = 'access.requested') AS access_requested,
  SUM(event = 'access.approved') AS access_approved,
  SUM(event = 'access.declined') AS access_declined
FROM usage_events
WHERE event IN ('invite.sent', 'invite.accepted', 'access.requested', 'access.approved', 'access.declined')
GROUP BY month
ORDER BY month
SQL
)"
```

## Engine versions in use yesterday

The version each engine reported in its last heartbeat of the day, with the update state it reported then.

```sh
bunx wrangler d1 execute DB --env staging --remote --command "$(cat <<'SQL'
SELECT engine_version,
  COUNT(*) AS engines,
  SUM(update_state = 'available') AS update_available,
  SUM(update_state IN ('pending', 'installing')) AS updating
FROM usage_daily_engines
WHERE day = date('now', '-1 day')
GROUP BY engine_version
ORDER BY engines DESC, engine_version DESC
SQL
)"
```

## Known gaps

- Someone active only in the last minutes before midnight UTC who comes back before the next run counts on the later day only: the rollup reads each session's last use, which has moved on.
- A person counts in their session's active organization only, not in every organization they belong to.
- An engine whose status object does not answer is missed by that run only. Every run rewrites today's and yesterday's rows, so a day is lost only if the object stays silent until the end of the next day.
- Nothing before usage data shipped: organizations and engines older than that have no `org.created`, `engine.first_heartbeat` or earlier events, and an engine that had already sent heartbeats never records a first one.
- Nothing here comes from inside the engine beyond what the heartbeat already carries (version, agent and member counts, setup, update state, CPU load).
