# 0027. Notifications: one system, in-app and email, counts only from engines

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Seb (roadmap interview and review of 2026-11-27)
- **Builds on:** [ADR 0018](0018-teams-and-member-access.md), [ADR 0016](0016-engine-capabilities.md), [ADR 0022](0022-usage-data-in-d1.md), [ADR 0026](0026-teams-v2.md) (team admins), [ADR 0025](0025-metering-and-subscriptions.md) (plan limits)

## Decisions on the questions raised

Seb accepted the proposals on 2026-11-27:

1. **Per-person counts.** "An agent is waiting for you" is personal, so the engine attributes counts to the dashboard user they are for. The platform then learns, per person and project, how many open items of each kind they have, and the engine owner can switch this off. Project-wide counts alone would never reach a member about their own work.
2. **The daily summary is off by default for everyone**, org owners included. It is offered after a person's third email in a week.

## Context

People hear about things only by email today, one template at a time: project offline, online, back online, access waiting, access granted. There is no in-app list, no preferences and no way to hear what happens inside a project.

What happens inside a project is engine content. The dashboard stores none (AGENTS.md rule 2), and the heartbeat carries only numbers and closed enums ([spec](../spec/zero-trust-spec.md#what-our-platform-can-and-cannot-do)). So the platform can say "something needs you in Marketing site", never what.

## Decision

1. **One notification system on the dashboard**, in-app on app.ptbk.io and by email, with per-person preferences and defaults by role.
2. **Two sources.**
   - **The platform** knows status, not content: project offline or back online, update waiting, join request waiting, plan limit reached, people and role changes, project removed ([ADR 0028](0028-clean-removal.md)).
   - **The engine** knows content: an agent waiting for someone, a task that failed, an AI tool that needs signing in again. It shows these in its own UI, with their content. For email it sends only a count per kind in the heartbeat.
3. **No spam for daily users.**
   - Email goes out only if the notification was not seen in-app within 15 minutes.
   - Repeats merge: one open notification per person, project and kind, whose count goes up.
   - At most one email per person and project per hour.
   - An optional daily summary replaces the immediate emails for the kinds the person chooses. It is off by default and offered after a person's third email in a week.
4. **Emails never carry content.** "2 things need you in Marketing site", the project's label (account metadata) and a link to `https://<hostname>/`. The dashboard knows no item IDs, so it never deep-links.
5. **Security and account emails stay outside.** Sign-up and recovery links, recovery notices, invitations and "you're in" emails are sent as today and cannot be turned off.

### Kinds and defaults

| Kind                                | Source   | Org owner   | Org admin   | Team admin (own team) | Member (own projects)        |
| ----------------------------------- | -------- | ----------- | ----------- | --------------------- | ---------------------------- |
| Project offline, back online        | platform | email       | email       | email                 | in-app                       |
| Update waiting                      | platform | in-app      | in-app      | in-app                |                              |
| Join request waiting                | platform | email\*     | email\*     | email\*               |                              |
| Plan limit reached                  | platform | email       | in-app      | in-app\*\*            |                              |
| People and role changes             | platform | in-app      | in-app      | in-app                | email, about themselves only |
| Project removed                     | platform | email       | email       | email                 | in-app                       |
| Agent waiting for you               | engine   | email       | email       | email                 | email                        |
| Task failed (to whoever started it) | engine   | email       | email       | email                 | email                        |
| AI tool needs signing in again      | engine   | email\*\*\* | email\*\*\* | email\*\*\*           |                              |

"Email" means in-app, plus email if unseen after 15 minutes. Everyone gets only projects they can see: org owners and admins all, team admins and members their teams'.

\* Only to people with access to that project, since only they can approve.

\*\* When the limit blocks a link they started.

A plan limit is one of [ADR 0025](0025-metering-and-subscriptions.md)'s meters (projects, every defined agent including disabled ones, members) reaching its quota, whichever subscription source the plan comes from, our Stripe or the website. The notification names the meter and links to the upgrade flow the source supplies; under a `warn` plan or the website's advisory licence it informs and never blocks.

\*\*\* Project-wide: to the project's managers the dashboard knows (below).

Preferences are per person and kind: off, in-app, in-app and email, or daily summary. Only overrides are stored, so a role change moves a person to the new defaults for everything they did not set.

### The heartbeat addition

Heartbeat v2 ([`heartbeat.ts`](../../packages/protocol/src/heartbeat.ts)) gets an optional field:

```ts
attention: z.array(
  z.strictObject({
    /** The dashboard user the items are for, from their access ticket. Absent: for the project's managers. */
    to: DashboardUserId.optional(),
    kind: z.enum(['agent-waiting', 'task-failed', 'tool-sign-in']),
    count: z.int().min(1).max(MAX_HEARTBEAT_COUNT),
  }),
)
  .max(64)
  .optional();
```

- A count is the number of open items of that kind that the person has **not yet seen in the engine UI**. Seeing or handling them there lowers it, so someone who works in the project gets no email.
- Kinds are a closed enum; a new kind is an addition in the same version (ADR 0010), accepted by the dashboard before engines send it.
- `HEARTBEAT_MAX_BODY_BYTES` rises from 4 to 8 KiB, so 64 entries fit beside 32 acks. The dashboard accepts the larger body before any engine sends one. (C-21 set it to 12 KiB: 8 KiB fits the dashboard's own IDs, but not every entry and ack with IDs at the 64 characters the schema allows. C-21 also allows one entry per `to` and `kind`.)
- The engine owner switches it off in the engine's settings; strict mode starts with it off. Switched off, the field is absent and the project's notifications are in-app only, inside the engine. The engine UI already shows the owner the exact last payload, this field included.
- v1 heartbeats get no field: only an engine that handles access tickets knows dashboard user IDs.

### Mapping counts to people

The engine is the authority on who is on it; the dashboard knows only the people it sent there.

- **An entry with `to`** goes to that dashboard user only if the dashboard issued them a ticket for this project, the engine acked it `approved`, and they are still in a team that holds the project. Anything else is dropped without a trace, so an engine cannot mail an arbitrary account.
- **An entry without `to`** goes to the project's managers as the dashboard knows them: the person who linked it, and org owners and admins and team admins of its team whose access to it is `approved`. Never to members.
- **People the dashboard did not send** (the setup-secret owner who did not link the project, anyone added by invite link) have no dashboard user ID on the engine. They see their items in the engine UI only; the owner's project-wide items reach whoever linked the project.
- Recipients are resolved again when the email is sent, so someone who left the team in the meantime gets nothing.

### Storage and timing

- `notifications (id, org_id, user_id, engine_id, kind, count, opened_at, updated_at, seen_at, emailed_at, closed_at)`, one open row per `(user_id, engine_id, kind)`. Repeats update `count` and `updated_at`. Engine rows close when the count drops to zero or the entry disappears. Closed rows are deleted after 30 days, like heartbeat values. No names or text beyond what the dashboard already holds.
- `notification_preferences (user_id, org_id, kind, channel)`: overrides only.
- The project's status Durable Object compares each heartbeat's `attention` with the last one and writes to D1 only on a change, so there is still no D1 write per heartbeat ([ADR 0022](0022-usage-data-in-d1.md)).
- A Cron Trigger every 5 minutes sends what is due: rows unseen and not emailed 15 minutes after they opened, merged into one email per person and project. The offline alert keeps its own threshold, which already waits, and counts as the delay. The same trigger sends daily summaries at 08:00 in the person's time zone, a new account setting defaulting to the browser's at sign-up.

### Email

Through the existing `EmailSender` port and the Cloudflare `send_email` adapter, behind the metered sender. New templates: `attention` (project label, hostname, counts by kind, link to the project), `notice` (one platform kind) and `daily-summary`. Each has a one-click unsubscribe link with a signed, single-purpose token, and `List-Unsubscribe` and `List-Unsubscribe-Post` headers (RFC 8058). The adapter's binding call gains headers for it.

### In-app on app.ptbk.io versus inside the engine

- **app.ptbk.io** gets a bell with the open notifications of the active organization. Opening the list marks platform rows seen. Engine rows read "2 things need you in Marketing site" with Open, and stay until the engine's count drops.
- **The engine UI** shows the items themselves, with content, through a new engine capability `notifications@1` ([ADR 0016](0016-engine-capabilities.md)): list, mark seen, unseen count per kind. The engine derives the heartbeat counts from it. Built by the engine team; engine-ui renders it.
- Neither embeds the other: the dashboard never frames the engine UI, and the engine UI loads nothing from app.ptbk.io (CSP).

### Phone push, later

Web Push from app.ptbk.io would carry the same content-free text through Apple's and Google's push services. Push from the engine itself could carry content, since Web Push payloads are encrypted to the device (RFC 8291), but it adds an outbound destination the owner must allow (security goal 4). Either needs its own ADR.

## Threat analysis

| Case                                 | Result                                                                                                                                                                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forged counts                        | The heartbeat is signed by the engine key and verified before parsing, as today.                                                                                                                                                                |
| A malicious engine spams people      | It reaches only people the dashboard sent to it, whose access it approved. Merging and the hourly cap bound the mail; anyone can switch the kind off, or leave the team.                                                                        |
| The platform learns activity         | Per person, project and kind: how many open items, every 60 seconds. Not what, not when each happened. Only the open row is kept, deleted 30 days after it closes. The owner can switch it off; strict mode starts off. Accepted as decision 1. |
| Content leaks into email             | The field holds a closed enum and a number; the email names the dashboard's own project label and hostname. Nothing from the engine is rendered.                                                                                                |
| Phishing through our emails          | Links go only to app.ptbk.io and the project's registered hostname. A compromised dashboard could link to a lookalike, as it could today; passkeys are bound to the real hostname, so a lookalike cannot sign anyone in.                        |
| Mail to someone who left             | Recipients are checked again at send time against team membership and approved access.                                                                                                                                                          |
| Unsubscribe token forged or replayed | Signed, bound to person and kind, and only ever turns email off.                                                                                                                                                                                |

What the platform can do to an engine does not change: this ADR adds one field the engine sends, nothing the platform sends.

## Contract changes

- `packages/protocol`: optional `attention` on heartbeat v2; the body cap rises to 8 KiB. Same version, additive (ADR 0010); the dashboard accepts both before any engine sends them.
- `packages/engine-api`: capability `notifications@1`.
- Conformance: `attention` never names a user without an approved ticket on that engine, stays within the caps, and is absent when switched off.
- Engine (engine team): the inbox, unseen counts, the owner's switch, the field.
- Dashboard: the two tables, the bell, preferences, the cron sender, three templates and unsubscribe. Today's status emails move onto the same rows and preferences.
- Spec: the heartbeat table gains "Things waiting, per person and kind | counts | Email when someone is away", and the metadata table its retention.

## Alternatives considered

- **The engine emails people itself.** Content stays local, but every engine needs a mail setup and deliverability work, and an outbound destination. The owner may still add it later as an engine feature.
- **Project-wide counts only.** Less metadata, but a member never hears about their own waiting agent. Rejected in decision 1.
- **The dashboard asks the engine what is new.** There is no command channel into the engine, by design. Rejected.
- **Encrypted content in the email.** Mail clients cannot decrypt it, and the dashboard would hold ciphertext of engine content. Rejected.
- **Email at once, no delay.** Simplest, but people working in the project would get mail about what they are looking at.

## Consequences

- People hear about what needs them without the platform learning what it is, and daily users get almost no mail.
- New metadata on the platform: per-person counts of waiting work. It is listed in the spec and the privacy policy, and the owner can turn it off.
- The engine team builds an inbox capability and the counts; until then, only platform notifications exist.
- The real engine already handles dashboard tickets (`members@1`, `access-requests@1` since 0.119.0-139), so it knows dashboard user IDs; per-person counts reach people once it ships `notifications@1` and the `attention` field.
