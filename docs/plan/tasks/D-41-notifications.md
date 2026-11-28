# D-41. Dashboard notifications: one pipeline, in-app and email

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M5
- **Depends on:** D-05, D-12, D-13
- **Status:** in progress (feat/d-41-notifications)
- **Spec:** ADR [0027](../../adr/0027-notifications.md) (behaviour, storage, timing, email, threat model); ADR [0018](../../adr/0018-teams-and-member-access.md), [0022](../../adr/0022-usage-data-in-d1.md), [0026](../../adr/0026-teams-v2.md), [0028](../../adr/0028-clean-removal.md); [docs/design/ui.md](../../design/ui.md)

## Goal

People hear about what needs them on app.ptbk.io and, when they are away, by email, through one notification system: a typed registry of kinds, one delivery pipeline, per-person preferences with role defaults. The platform learns and sends nothing it does not already own.

## Decisions (Seb, 2026-11-27)

- **UI.** A bell with an unread dot in the header. Its dropdown lists the active organization's open notifications ("2 things need you in Marketing site" [Open], "Sales bot is offline since 10:42" [Open]) and a "Notification settings →" link. Preferences live in Account settings: per kind off / in-app / in-app and email, only overrides stored. No notifications page. Calm, graphite, Inter, quiet copy; works at phone widths (U-28). EN and CS.
- **Multi-org.** The bell lists the active organization; the org switcher shows a dot beside other organizations with unseen notifications. Emails come from every organization.
- **Preferences are personal.** No organization defaults or admin overrides in v1; defaults come from the role. The resolution step (`override ?? default(role)`) is one function, so organization defaults can slot in between later.
- **Sender.** The existing `EMAIL_FROM`, no Reply-To. Every notification email ends with "This mailbox isn't read. Manage your notifications: <Account settings link>" and the unsubscribe link.
- **Engine counts** (`attention`) are on by default in the engine, off in strict mode, and the owner can switch them off (ADR 0027).
- **Not in this release:** the daily summary and the time-zone setting. The delivery step picks a channel per row (`off | in-app | email`); a `daily-summary` channel is one more value there and one more job.
- **Never learn what is end-to-end encrypted on the engine.** Rows and emails hold only what the dashboard owns: project label, hostname, organization name, kind, a closed variant, a count and timestamps. No engine-provided text, names, titles, item IDs or URLs beyond `https://<registered hostname>/`. `attention` is parsed strictly; anything beyond ADR 0027's shape refuses the heartbeat. Logs never pair a recipient with anything engine-derived.

## Design

### The kind registry (`src/shared/notifications/`)

One definition per kind, shared by the Worker (pipeline, email) and the SPA (bell, settings), so the two cannot disagree on ids, defaults or copy.

- `id`, `source` (`platform` | `engine`), `variants` (a closed enum per kind, may be empty). Whether a row is about a project or the organization is the producer's `engineId` (or `null`).
- `defaults`: a channel per recipient role, `org-owner`, `org-admin`, `team-admin`, `member`. `team-admin` resolves to nobody until ADR 0026 lands.
- `audience(event)`: who may hear it, as a closed descriptor the recipient directory resolves (`project-viewers`, `project-managers`, `org-managers`, `person`), and `reach` (`viewers`, `managers`, `managers-or-approved`), checked **again at send time**. The rules live once, in `domain/notifications/recipient-rules.ts`, for every adapter.
- `reduce(openRow, event, now)`: how an event changes the person's one open row of this kind and project: keep, close, or put (count, variant, re-arm).
- `timing`: email delay, whether the hourly cap applies, whether a seen row closes, how long an untouched row lives.
- `copy`: the in-app line, the email subject and paragraph, the link (`dashboard` path, or the project's `/` or `/members`), the settings label. Every value it may read is dashboard-owned.

Engine kinds have no `audience` or `reduce`: their rows are set from the heartbeat's counts (`syncAttention`), with the mapping below. Their ids are typed against the protocol's `AttentionKind`, so a kind the protocol adds without a definition here fails to compile.

The interface (`src/shared/notifications/notification-kind.ts`):

```ts
interface KindBase<K extends string, V extends string> {
  readonly id: K;
  readonly reach: Reach; // 'viewers' | 'managers' | 'managers-or-approved', checked at send time
  readonly variants: readonly V[];
  readonly defaults: Readonly<Record<RecipientRole, NotificationChannel>>; // 'off' | 'in-app' | 'email'
  readonly timing: NotificationTiming<V>; // emailDelayMs, hourlyCap, closesWhenSeen(variant), lifetimeMs
  readonly copy: NotificationCopy<V>; // label, line, subject, detail?, link
}
interface PlatformKind<K extends string, E, V extends string> extends KindBase<K, V> {
  readonly source: 'platform';
  audience(event: E): Audience;
  reduce(row: OpenNotification<V> | null, event: E, now: number): NotificationChange<V>; // keep | close | put
}
interface EngineKind<K extends string> extends KindBase<K, never> {
  readonly source: 'engine';
}
```

**Adding a kind** = one definition file, its entry in `NOTIFICATION_KINDS`, its messages in `messages/{en,cs}.json`, a test; the producer calls `notifications.notify(kind, { orgId, engineId }, event)`. Nothing in the pipeline, store, email or UI changes.

- **Project removed** (ADR 0028's lane): `kinds/project-removed.ts` with `reach: 'viewers'`, audience `project-viewers`, ADR 0027's defaults (owner, admin and team admin email; member in-app), `closesWhenSeen: () => true`, a `dashboard` `/` link (the project is gone, so never its hostname). The removal flow calls `notify('project-removed', { orgId, engineId }, { kind: 'removed' })` before it deletes the engine's team, since the audience is resolved from it. Then close the project's other rows: a `close` change from each kind is enough, or one `closeForEngine` store method if that lane prefers.
- **Team admins** (ADR 0026's lane): `directoryPeople` in `recipient-rules.ts` maps a team-admin member to `role: 'team-admin'` and `manager` when their access is approved; every kind already declares its `team-admin` default, and nothing else changes.
- **Plan limit reached** (D-40, PR #388): `kinds/plan-limit.ts` with the meter as its variant (`projects`, `agents`, `members`), audience `org-managers` (organization level, `engineId: null`; the person whose link it blocked as a second `notify` with `person`), defaults owner email, admin in-app, team admin in-app, `closesWhenSeen: () => false`, closed by an `under-limit` event; `checkMeterLimit` calls `notify` when a meter reaches its quota.

### Kinds in this task

| Kind             | Source   | Variants                           | Producer                                                                                    |
| ---------------- | -------- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| `project-status` | platform | `online`, `offline`, `back-online` | The status Durable Object: first heartbeat (setup reminder), offline threshold, back online |
| `update-waiting` | platform | (none)                             | The status Durable Object, when `update` turns `available` and back                         |
| `join-request`   | platform | (none)                             | Heartbeat v2: new tickets awaiting approval, and their acks                                 |
| `people-change`  | platform | `joined`, `role`, `added`          | Accepting an invitation, changing a role, adding someone to a team                          |
| `agent-waiting`  | engine   | (none)                             | `attention` (C-21)                                                                          |
| `task-failed`    | engine   | (none)                             | `attention` (C-21)                                                                          |
| `tool-sign-in`   | engine   | (none)                             | `attention` (C-21)                                                                          |

- Today's status emails (offline, online, back online) move onto `project-status`: the offline threshold is the delay, so its email goes on the next delivery run; back online re-arms the row only for people the offline email reached, and closes it for everyone else.
- The access-waiting email moves onto `join-request` and keeps naming the requesters, which the dashboard owns (its own tickets), read at send time. "You're in", invitations, sign-up and recovery stay outside and cannot be turned off.
- `update-waiting`: `available` is the state where the engine waits for someone; `pending` and `installing` are the engine's own work.

### Mapping engine counts to people (ADR 0027)

- An entry with `to` reaches that user only if they are in the team holding the project with `access = approved` (which only an `approved` ticket ack sets). Otherwise it is dropped without a trace.
- An entry without `to` reaches the project's managers: the person who linked it, and owners, admins and team admins in its team with approved access. Never members.
- A person's rows are the sum per kind; a kind missing from the latest `attention` closes their row. The status object keeps a SHA-256 digest of the last `attention` the pipeline took (never the counts) and calls it only on a change. Absent (`attention` switched off, C-21) reads like `[]`: the engine's rows close and its notifications stay inside the engine.

### Storage (migration `0019_notifications`, `0018` until #388 lands)

- `notifications`: ADR 0027's columns plus `variant` (closed per kind) and `due_at` (when its email is due; null when nobody owes one). One open row per `(user_id, org_id, engine_id, kind)`; `engine_id` is null for organization-level kinds.
- `notification_preferences (user_id, org_id, kind, channel)`: overrides only; choosing the role default deletes the override.

### Delivery (cron every 5 minutes)

Rows with `due_at <= now`, grouped per person and project, re-resolved (still in the audience, channel still `email`, platform rows still unseen), then one email per group. The hourly cap per person and project moves `due_at` to when it lifts. `project-status` is exempt, as today's status emails were. Seen rows of `closesWhenSeen` kinds close after a day, untouched rows after their kind's lifetime, closed rows are deleted after 30 days.

### Email

One `notifications` template per person and project, plain text, through the `EmailSender` port and the metered sender. `List-Unsubscribe` (an HTTPS URL with the token) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058); the Cloudflare adapter passes `headers` to the binding. The token is HMAC-SHA-256 under a key derived with HKDF from `RATE_LIMIT_HMAC_KEY` (info `ptbk-notification-unsubscribe-v1`), so no new secret is deployed; it binds user, organization and the kinds in that email, and its only effect is turning email off for them.

### Routes

| Route                                     | Auth    | Permission / limit                                                        |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------- |
| `GET /api/notifications`                  | session | `notification.read`                                                       |
| `POST /api/notifications/seen`            | session | `notification.manage`                                                     |
| `GET /api/notification-preferences`       | session | `notification.read`                                                       |
| `PUT /api/notification-preferences/:kind` | session | `notification.manage`                                                     |
| `POST /email/unsubscribe?token=`          | public  | `unsubscribe-ip`; outside `/api`, since mail providers post it cross-site |

Both actions are org-scoped for every role and read and write only the session user's own rows.

## Scope and PRs

1. Registry, tables, store (D1 and memory, one contract suite), pipeline, delivery job, email template and unsubscribe, platform kinds wired (#393).
2. Bell, org-switcher dot, preferences in Account, unsubscribe page (stacked on 1).
3. Engine kinds: `attention` diffing in the status object and ingestion (stacked on 1 and C-21, #392).

## Where this differs from ADR 0027, and why

- **Two more columns:** `variant` (a closed enum per kind, so `project-status` is one preference with three moments) and `due_at` (when an email is owed, so the 5-minute job reads only those rows and an in-app-only row is never re-read).
- **One email template** (`notifications`), not `attention` and `notice`: emails merge per person and project, so one message can hold both platform and engine kinds.
- **Back online** emails only people who got the offline email (as today), and is exempt from the hourly cap with the other status emails. A re-armed row that was already emailed starts a fresh row, so the cap still sees the earlier email.
- **First online** ("finish setup") moved onto `project-status` too, with no delay, as today.
- **Join requests** go to the project's managers (the ADR's "mapping" managers), and name the waiting people the dashboard sent there, read at send time from its own tickets. They now wait 15 minutes unseen, as the ADR's table says.
- **Seen in the bell** holds back email for platform kinds only; for engine kinds the engine's count is already "unseen in the engine UI", so the email still goes unless the count drops.
- **Unsubscribe key** is derived from `RATE_LIMIT_HMAC_KEY` (HKDF, own info string), so no secret is added; rotating that key ends old unsubscribe links.
- **Delivery time** is the Cron Trigger's scheduled time, which lets e2e run it as of 16 minutes later through the dev server's trigger endpoint.
- Not in this release, as decided: the daily summary, time zones, organization defaults.

## Out of scope

- Daily summary and time zones; organization defaults; push; a notifications page; `plan-limit`, `project-removed` and team-admin recipients (their own lanes, see above).

## Acceptance criteria

- [ ] Pipeline tests with fakes: merge into one open row with a count; seen platform rows are not emailed; email only after the delay; one email per person and project; hourly cap; recipients re-resolved at send time; preference `off`, `in-app`, `email`; closed rows deleted after 30 days.
- [ ] Status object tests: online, offline and back-online notify once each; back online emails only people the offline email reached.
- [ ] Engine mapping tests: `to` without approved access dropped, `to` of someone who left dropped, entries without `to` to managers only, a vanished kind closes, extra fields in `attention` refuse the heartbeat.
- [ ] Rendered emails and in-app rows contain only dashboard-owned fields (test with sentinel strings).
- [ ] Unsubscribe: forged, tampered and other-purpose tokens refused; a valid one turns email off for exactly its kinds; GET changes nothing; headers present.
- [ ] Route-table test passes with the new routes; policy actions deny by default.
- [ ] SPA tests: bell, dot, dropdown, mark seen, preferences, both locales, phone width.
- [ ] **Status** line above set to `done (#<PR>)`.
