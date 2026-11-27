# 0025. Meters, plan limits and subscription sources

- **Status:** Proposed
- **Date:** 2026-11-27
- **Extends:** [ADR 0017](0017-billing-entitlements.md) (the entitlements port, plans as configuration), [ADR 0021](0021-website-license-authority.md) (the website owns licences; coverage is advisory) and [ADR 0022](0022-usage-data-in-d1.md) (usage data in D1)

## Context

Seb decided on 2026-11-27 that v1 bills by **counts**: projects, defined agents (every agent that exists in a project, for now) and members. There is no token or spend tracking. Later the agent count may become "agents that ran in the period", and other counts will follow, so a new count must not need a rewrite.

The pieces exist but don't meet. ADR 0017's `Entitlements` port answers `allows` and `limit` from a plan catalogue, with one quota that counts anything (`engines.max`). ADR 0021 made the website the commercial authority for its offer and its coverage advisory. ADR 0022 keeps each engine's last heartbeat counts per day. Nothing turns those counts into a number a plan can limit, per organization, team and project, with a history.

Seb's further decisions, fixed for this ADR:

- Each meter is a plug-in behind one interface. Plans and subscriptions bundle meters into limits and features, and plans are configuration, not code.
- The subscription source is a connector: website licences (today), Stripe (ADR 0017), or a manual grant from a future platform admin console. The rest of the dashboard asks only the entitlements port.
- Over a limit, running work is never stopped. Creating something new (another project) shows an upgrade flow; whether the limit blocks or only warns is set per plan. A future admin console lists organizations over a limit, for sales.
- Engine-reported counts (heartbeat `agents`, `members`) are trusted. Sudden drops get flagged in the admin console later.

## Decision

### What the dashboard can know

A meter counts only what the dashboard already holds as metadata (AGENTS.md rule 2):

| Fact                           | Source                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| An organization's projects     | Its active engines (`engines.status = 'active'`); revoked and suspended engines don't count       |
| A project's team               | `engines.team_id`; a team has at most one project today, and may have none                        |
| A team's and the org's people  | `team_members` and `memberships`: the people the dashboard invited                                |
| A project's agents and members | The engine's last reported heartbeat (`agents`, `members`), from `usage_daily_engines` (ADR 0022) |

It cannot know which agents exist or ran, their names or state, who an engine's members are (so it cannot tell that two projects share a person), or anything inside a project. A meter that needs more is an opt-in heartbeat field agreed with the engine team, as ADR 0022 says, never a read into the engine.

### Meters

A meter is a pure function from those facts to a reading (`apps/dashboard/src/domain/metering/`):

```ts
interface Meter {
  readonly id: MeterId; // a closed list: 'projects' | 'agents' | 'members' | 'people'
  readonly quotas: { readonly org: Quota | null; readonly project: Quota | null };
  measure(facts: OrgUsageFacts): MeterReading;
}

interface MeterReading {
  readonly org: MeterCount;
  readonly teams: readonly (MeterCount & { readonly teamId: TeamId })[];
  readonly projects: readonly (MeterCount & { readonly engineId: EngineId })[];
}

/** `value` counts what is known; `unreported` projects have not sent the count yet, so `value` is a lower bound. */
interface MeterCount {
  readonly value: number;
  readonly unreported: number;
}
```

The v1 meters:

| Meter      | Per project                    | Per team and org          | Quotas                                   |
| ---------- | ------------------------------ | ------------------------- | ---------------------------------------- |
| `projects` | 1                              | its active projects       | `engines.max`                            |
| `agents`   | the last heartbeat's `agents`  | the sum over its projects | `agents.max`, `agents.per-project.max`   |
| `members`  | the last heartbeat's `members` | the sum over its projects | `members.max`, `members.per-project.max` |
| `people`   | its team's people              | team or org members       | `people.max`                             |

A project without a heartbeat yet is `unreported` for `agents` and `members`: unknown is never zero (ADR 0021). A team without a project has zero of every engine-side meter, which is known. `members` sums per project because the dashboard cannot de-duplicate engine members; `people` is the de-duplicated count of the people the dashboard invited. A plan limits whichever it needs.

A new meter, such as "agents that ran in the period" (`agents-active`), is one file and one entry in the closed list, plus the heartbeat field it reads. No migration, route or plan-schema change: its quotas are named `<meter>.max` and `<meter>.per-project.max`, and the history stores meters by name.

### Daily history

`usage_daily_meters` stores each reading per UTC day: `(day, org_id, scope, scope_id, meter)` with `value`, `unreported` and `peak`, where `scope` is `org`, `team` or `project` and `scope_id` the organization, team or engine ID. The `usage-rollup` job (ADR 0022's `*/15` cron) measures every organization with a project or a team after it writes the engine days, and rewrites today's rows: `value` is the latest reading, `peak` the day's highest. A repeated run changes nothing beyond the latest value, and the last run of a day leaves that day's final value. Retention is the rollups' 25 months, and rows go with their organization (`ON DELETE CASCADE`). `meter` has no CHECK, like `usage_events.event`.

Organizations with neither a project nor a team are not written: their readings are zero apart from `people`, which `memberships` already holds.

Billing a period later reads the period's daily peaks; flagging a sudden drop compares a day with the one before. Both are queries on this table, not new storage.

### Plans and limits

Plans stay configuration (`BILLING_PLANS`, `BILLING_OFF_PLAN`). They gain:

- **Meter quotas**, beside `engines.max` and `custom-domains.max`: `<meter>.max` for the whole organization and `<meter>.per-project.max` for each project. The projects meter keeps `engines.max`, the name existing configuration uses. A meter quota a plan leaves out is unlimited, so every existing plan parses unchanged.
- **`overLimit`**: `block` or `warn`, for the plan as a whole. Absent is `block`, which is what `engines.max` does today.

The port grows one method; `allows` and `limit` stay as ADR 0017 defined them:

```ts
interface Entitlements {
  allows(orgId: OrgId, feature: Feature, signal: AbortSignal): Promise<boolean>;
  limit(orgId: OrgId, quota: Quota, signal: AbortSignal): Promise<number | null>;
  overLimit(orgId: OrgId, signal: AbortSignal): Promise<'block' | 'warn'>;
}
```

### Entitlements from subscription sources

A subscription source is a connector that resolves an organization to the plan entitlements it holds today. The entitlements port reads it and nothing else does:

| Connector | Resolves                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------- |
| `stripe`  | The subscribed plan while the subscription is live, otherwise `none` (ADR 0017, unchanged)                                |
| `off`     | `BILLING_OFF_PLAN` for every organization (ADR 0017's update)                                                             |
| `website` | Every quota unlimited and `overLimit: warn`. The licence's own grants keep ADR 0021's per-grant coverage and check points |
| manual    | Later: a plan or quotas a platform admin grants an organization, with a validity, recorded in D1 and audited              |

`ADAPTERS.billing` selects the money connector, as today. A manual grant, once it exists, overrides the money connector for its organization while it is valid, so sales can extend a trial or a custom deal without touching the website or Stripe.

The website connector does not map licence capabilities onto meters yet. ADR 0021 forbids silently relabelling heartbeat `agents` as `specialists` or `members` as `controllingUsers`. If Seb confirms they mean the same thing, the mapping is a table in the website connector (`engineProjects` → `engines.max`, `specialists` → `agents.per-project.max`, `controllingUsers` → `members.per-project.max`), and ADR 0021's coverage keeps deciding which grant covers which project.

### Limit checks and the upgrade flow

`checkMeterLimit(orgId, meter, { adding, project })` answers `ok`, or `warn` or `block` with the meter, the scope (`org` or `project`), what is used and the limit. It compares the reading's known value plus what the action adds with the quota; an unreported count never blocks. `block` happens only under a plan with `overLimit: block`; otherwise a shortfall is `warn`.

It is asked only when the dashboard is about to create something, and never of running work, an issued link code, a heartbeat, registration or access:

- **Projects:** when a link code is issued (`engine.link`).
- **People:** when invitations are sent (`member.invite`).
- **Agents and engine members** are created inside the project, where the dashboard is not. Their limits can only be reported, whatever `overLimit` says: in `GET /api/usage`, on the screens later, and in the admin console's over-limit list. Making the engine refuse a new agent would be an engine-side check, a contract change with the engine team.

The upgrade-flow hook is the answer itself: `block` is a 403 problem `limit-reached` carrying `{ meter, scope, used, limit }`, and `warn` a success with a `limitWarning` of the same shape. The SPA turns either into the upgrade flow, whose target (website, Stripe Checkout, contact) the connector supplies. With billing `website`, ADR 0021's `LicenseGate` stays the check point for its licence, and the entitlements answer `warn`, so nothing it decided changes.

The admin console's over-limit list is a query: the latest `usage_daily_meters` rows against each organization's entitlements, computed when read, because plans change.

### Exposure

`GET /api/usage` (session, `usage.read`: owners and admins) answers the current readings of every meter with their limits and the plan's `overLimit`. It is read-only; the team view and the admin console use it or the table.

## Open decisions for Seb

1. **Who takes the money: the website, Stripe, or both.** The design works with any: each is a connector behind the same port, and `ADAPTERS.billing` picks one per deployment. Running both at once needs a rule for which connector an organization uses (for example, a website link wins over a Stripe customer) and must never create two subscriptions for one customer (ADR 0021). Until decided, the website stays the authority for its offer.
2. **Whether disabled or archived agents count.** The `agents` meter reads heartbeat `agents` as defined today, which counts every agent. If only some should count, the engine reports a second number (an additive heartbeat field) and a new meter reads it; plans move to its quotas, nothing else changes.

## Alternatives considered

- **One quota per count, read ad hoc where it is checked** (how `engines.max` works today): no new interface, but every count grows its own query, history and unknown handling, and the admin console would have to repeat them.
- **Meters that query storage themselves**: each meter independent, but the job would run one query per meter and organization, and every meter would have to learn what "unknown" and "revoked" mean. Pure meters over one set of facts keep those rules in one place and batch the reads.
- **History derived from `usage_daily_engines` at query time**: no new table, but team membership and project counts change over time and are not in it, and every new meter would need its own derivation. Storing readings keeps a day's answer as it was.
- **Blocking over-limit agents on the engine now**: enforces the agent limit, but needs a contract change and lets billing reach into running work, which Seb ruled out.

## Consequences

- A new meter or quota is a code change in one place and a configuration change in the plans; pricing changes stay configuration.
- The dashboard can show and limit what it creates (projects, invited people) and only report what engines create (agents, engine members).
- Counts trust the engine. A tampered engine can under-report; the history makes sudden drops visible, and the admin console flags them later.
- The rollup writes `meters × (1 + teams + projects)` rows per organization every 15 minutes, one D1 batch. Past a few thousand organizations it should write only changed rows.
