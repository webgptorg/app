# U-29. Engine UI: the inbox and the owner's attention switch

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M5
- **Depends on:** C-21, M-16
- **Status:** in progress (feat/u-29-notifications-ui)
- **Spec:** ADRs [0027](../../adr/0027-notifications.md), [0016](../../adr/0016-engine-capabilities.md), [0015](../../adr/0015-ui-architecture-and-design-system.md); [engine-api.md](../../engine-integration/engine-api.md#notifications)

## Goal

People see what waits for them inside the project, with its content, and open it in one step. The owner sees whether each heartbeat tells app.ptbk.io how many things wait, and can switch it off.

## Decisions (Seb, 2026-11-27)

- Sharing the counts is on by default and off by default in strict mode; the owner can switch it off, and the settings switch shows which it is.
- Nothing engine-local reaches app.ptbk.io: the inbox loads nothing from another origin, and the dashboard learns only counts per person and kind, through the heartbeat.

## Scope

- Feature `notifications` (`notifications@1`, no permission: everyone has an inbox). Without the capability there is no entry point, no route content and no settings row.
- An inbox entry in the shell with the unseen `total` as a badge, reachable on phones; counts refetch every 60 seconds, on window focus and after mark-seen.
- `/inbox`: open items newest first, title and detail as text only, the kind quietly, project-wide items marked as for the project, relative time, a link into the item (chat, run, task, the AI tool's settings; none for a `null` target), unseen ones a little stronger, more via `nextCursor`, a calm empty state.
- Showing unseen items marks them seen (one request of up to 100 IDs) and refreshes the counts; a 404 refetches.
- Settings → Security: the owner's switch, with `settings.manage` and the capability, behind step-up, with quiet copy on what the counts say and what they never say, and a link to the last heartbeat.
- The heartbeat details label `attention`. English and Czech messages.

## Out of scope

- Handling an item from the inbox (answering, retrying, signing in): the link goes where that happens. Browser or push notifications.

## Acceptance criteria

- [ ] Component tests: no UI without the capability, the badge count, text-only rendering of a title with markup, links per target kind, mark-seen on view and the 404 refetch, the switch on and off and its permission gating; axe passes.
- [ ] The CSP browser test visits `/inbox` with seeded items and sees no request to another origin.
- [ ] The bundle budget holds, or is raised with the measured numbers and why.
- [ ] **Status** line above set to `done (#<PR>)`.
