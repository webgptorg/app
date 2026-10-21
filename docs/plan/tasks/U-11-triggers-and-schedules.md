# U-11. Triggers and schedules

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** U-02, C-07
- **Status:** in progress (feat/u-11-triggers)
- **Spec:** Enterprise-ready engine architecture (API, Authorisation, Audit); ADRs: [0015](../../adr/0015-ui-architecture-and-design-system.md), [0016](../../adr/0016-engine-capabilities.md)

## Goal

When the engine advertises `triggers@1`, members see what starts their agents (inbound email addresses and schedules), with next and last fire and a fire history linked to runs, and can create, edit, pause, resume and delete them where permitted.

## Context

Triggers are how agents work without someone chatting: an inbound email starts an `email`-source run, a schedule (once, interval or cron, with start, end and a maximum run count) sends its message on time (C-07). Owners must be able to stop anything in one or two steps (docs/design/ui.md), so pause and resume are primary, mobile-first actions. Webhooks exist in the contract as `draft` only and are shown as coming later. The feature registers itself in the registry (U-02); without `triggers@1` nothing of it appears.

## Scope

- Feature module `src/features/triggers/` registered in `src/app/features.ts` with `defineFeature({ id: 'triggers', requires: { capability: triggers@1, permission: 'triggers.read' }, … })`:
  - `nav`: group `resources`, "Triggers", to `/triggers`; `agentTabs`: "Triggers" at `/agents/$agentId/triggers`.
  - `agentOverviewCards`: active triggers with next fire, paused and failed counts.
  - `activityRenderers`: `trigger.*` (version 1) for `trigger.fired` (linking to the run when `runs@1` is advertised), `trigger.failed`, `trigger.paused`, `trigger.resumed`.
  - `attention`: count of `failed` triggers, linking to `/triggers?lifecycle=failed`.
  - `commands`: "Pause trigger" and "Resume trigger" (`triggers.manage`, listing matching triggers), "New schedule", "Go to triggers".
- Routes `/triggers`, `/triggers/$triggerId`, `/agents/$agentId/triggers`, `/triggers/new` (`triggers.manage`) with `requireFeature('triggers')`. Typed search params `kind`, `lifecycle`, `agentId`, `cursor`, sent to C-07's `GET /triggers`.
- List: `DataTable` in server-side mode: name, agent, kind, lifecycle badge with text, schedule summary or email address, next fire, last fire; a pause or resume button in each row and card; card layout below 768 px.
- Detail:
  - Email: the engine-assigned address as `CodeText` with `CopyButton`.
  - Schedule: recurrence described in words ("Every weekday at 08:00, Europe/Prague"; "Every 15 minutes"; "Once on 3 November at 10:00"), the raw cron expression, time zone, `startsAt` and `endsAt`, run count against `maxRunCount`, next and last fire as local time with the trigger's zone shown when it differs; the planned message as plain text.
  - Fire history from `GET /triggers/{id}/fires` (`DataTable`, cursor paging): time, outcome badge, error summary, run link when `runs@1` is advertised.
- Create and edit (`can('triggers.manage')`), `@ptbk/ui` form layer with a zod schema: agent, name, recurrence kind (`once` with a date and time, `interval` with amount and unit, `cron` with expression), time zone (select from `Intl.supportedValuesOf('timeZone')`, default the browser's), start, end, maximum runs, message. A local preview of the next five fire times is a hint only; the server's 422 `invalid-schedule` is authoritative and mapped onto fields with `applyServerErrors`. Creating an email trigger needs only agent and name; the address is shown after creation.
- Pause and resume: one tap, optimistic lifecycle change with rollback on error, toast on outcome; a 409 `trigger-ended` explains that ended triggers cannot resume. Delete: `ConfirmDialog` naming the trigger; waits for the server.
- Webhooks: shown as "Coming later" in the kind choice, disabled; nothing is built.
- Live: `trigger.changed` events and `trigger.*` activity invalidate the affected list and detail; next-fire countdowns tick from one shared clock hook, nothing polls.
- Hooks `useTriggers(filters)`, `useTrigger(id)`, `useTriggerFires(id)`, `useTriggerMutations()`, `triggerKeys` and `queryOptions` shared with loaders.

## Out of scope

- Webhook triggers (contract `draft`). Starting a run by hand (chat, U-05). Email sender allow-lists or filtering rules.

## Design notes

- Cron preview and description: `cron-parser` 5.x (no DOM, no `eval`, no runtime styles; time-zone aware through `Intl`) and a small in-house describer over its parsed fields with translated templates, both behind `src/features/triggers/schedule/` so they can be swapped. If its bundle cost exceeds the route budget, lazy-load it with the form and flag it in the PR.
- All times are computed and shown with `Intl.DateTimeFormat` and an explicit `timeZone`; never shift instants by hand.
- Unknown trigger kinds or lifecycles from a newer engine render as their raw value with a generic card, never an error.
- Design-system components and semantic tokens only.

## Acceptance criteria

- [ ] With seeded triggers: kind, lifecycle and agent filters and the cursor are written to the URL and restored on reload; paging reaches every trigger.
- [ ] Schedule descriptions in `en` and `cs` for once, interval and cron (incl. weekday and step expressions); unknown cron syntax falls back to the raw expression.
- [ ] Time zone tests with a fake clock: a `Europe/Prague` cron at 02:30 across the March and October DST changes previews the times the library computes and shows them with the zone; a trigger in another zone than the browser's shows both.
- [ ] Form: invalid local input blocks submit; a server 422 `invalid-schedule` lands on the right field; the preview never blocks submit.
- [ ] Pause and resume update optimistically, roll back on error with a failure toast, and 409 `trigger-ended` shows its message; without `triggers.manage` no create, edit, pause, resume or delete controls exist.
- [ ] Fire history links to runs only when `runs@1` is advertised; a `trigger.fired` activity renders through the registered renderer.
- [ ] Without `triggers@1` the nav item, agent tab and card are absent and `/triggers` shows "not available on this engine".
- [ ] Skeleton, empty, no-results and error states each have a test; at 360 px pause and resume are reachable without horizontal scroll; `axe-core` passes; `test:csp` visits list, detail and form with zero violations and passes the UX checks (layout shift, reduced motion); routes stay within their bundle budgets.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Local cron semantics may differ from the engine's scheduler (seconds field, `L`/`W`, DST gaps); the preview is labelled as an estimate and the detail shows the engine's `nextFireAt`. Agree the cron dialect with the engine team before E-01.
- Whether members may create triggers on agents they do not own is engine policy; the UI relies on 403 handling.
