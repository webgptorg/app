# U-08. Home, activity feed and command palette

- **Lane:** U · **Module:** `apps/engine-ui`, `packages/ui` (one new module, `CommandPalette`) · **Milestone:** M2
- **Depends on:** U-02, C-07
- **Status:** done (#62)
- **Spec:** Security hardening (preamble: nothing limits the owner, 5 agent output is untrusted), Enterprise-ready engine architecture (Authorisation); ADRs: [0006](../../adr/0006-organizations-and-roles.md), [0015](../../adr/0015-ui-architecture-and-design-system.md), [0016](../../adr/0016-engine-capabilities.md); product brief: [docs/design/ui.md](../../design/ui.md) (Key screens: Home; Shell: command palette)

## Goal

Signing in lands on a role-aware home: a calm control center for members who oversee the engine (counts, needs attention, recent agents, a live activity feed, update available) and a personal home for everyone else, plus a ⌘K command palette that jumps anywhere and runs registered actions.

## Context

Owners must see everything their agents do and stop anything in one or two steps (ui.md, Calm control). Home is the first screen after sign-in, so it sets the product's character: fast, quiet, live. "Role-aware" still means permission-aware ([ADR 0006](../../adr/0006-organizations-and-roles.md)): the variant is chosen from permissions, never from the role name. The activity feed is C-07's discriminated union; each capability's UI module (U-09 to U-12) registers renderers for its kinds through U-02's registry, so this task owns the feed, the lookup and the fallback, not every card. Data comes only through `EngineApiClient` (C-04, C-07).

## Scope

- Feature `src/features/home/` registered with `defineFeature` (`id: 'home'`, `nav: { group: 'work', order: 0, to: '/' }`, no capability required). `/` renders home and replaces U-01's redirect to `/agents`.
- `homeVariant(permissions)` (pure): `'control-center'` when the member holds `security.read`, else `'member'`. Widgets inside each variant are further gated by capability and permission.
- **Control center** (mobile-first single column, two columns from 1024 px):
  - Greeting with the member's display name and time of day, quick action "New agent" (shown with `can('agents.write')`).
  - Counts: agents (the list's total when the API provides it, otherwise omitted), running now and queued (C-07's `GET /runs/stats`, `runs@1`), needs attention (sum of every registered `attention` provider's `useAttention()`, each linking to its filtered view).
  - Recent agents (`GET /agents?sort=-updatedAt&limit=6`), with live state from the registered `agentStatusProvider` when present.
  - Update available: `Banner` from C-04's `GET /security` (`update.status === 'available'`, with version and earliest install time) and on an `engine.update-available` activity; links to `/security`.
  - Live activity feed (below).
- **Member home:** agents the member can use (`GET /agents?sort=-updatedAt`), recent chats, and "my running work" (`GET /runs?createdBy=<me>&status=queued,running`, only with `runs@1` and `runs.read`).
- **Activity feed** (`src/features/home/activity/`): first page from `GET /activity` (`useInfiniteQuery`, "Load older"), then `/events` `activity` events from U-03's app-wide subscription prepended to the cache with `setQueryData`; no polling. New items slide in (motion tokens; a fade under reduced motion). While the reader has scrolled down, new items collect behind an "N new" button instead of shifting the list. One `aria-live="polite"` region announces batched summaries at most once per 10 s. Filter chips by prefix (`run.`, `file.`, `trigger.`, `integration.`, `member.`, `engine.`), shown only for visible features, bound to a typed search param.
- **Renderer lookup** (`resolveActivityRenderer`): exact `kind` with a matching `v`, then the `prefix.*` entry for that `v`, then the generic fallback card. C-07's `parseActivity` results `unknown` and `invalid` always get the fallback card: icon, time, agent name and the raw kind as text, never the payload. This task registers renderers for `member.*` and `engine.*`; U-09 to U-12 register theirs.
- **Command palette:** new `@ptbk/ui` module `components/command-palette/` (tokens, gallery entry, tests): native `<dialog>`, ARIA 1.2 combobox with a listbox, grouped results, `↑`/`↓`/`Enter`/`Esc`, focus returns to the opener, no information by colour alone. In engine-ui: ⌘K / Ctrl+K anywhere, and a header search button (the only entry on touch devices). Results: navigation to every visible nav entry and settings section, agents (`GET /agents?q`, debounced 200 ms, aborts the previous request), recent runs by ID when `runs@1` is visible, and every visible registered command (e.g. "New agent" from U-04, "Stop run" from U-09). Commands are filtered by their `requires`.
- States: skeletons shaped like each widget, empty states (no agents yet with "New agent"; no activity yet), per-widget error states with retry so one failing endpoint does not blank home; the route error boundary catches the rest (U-02).
- Hooks and keys in `src/features/home/` (`homeKeys`, `activityKeys`, `queryOptions` shared with the loader); every string in `en` and `cs`.

## Out of scope

- Renderers for `run.*`, `file.*`, `trigger.*`, `integration.*` (U-09 to U-12) and their detail views.
- Notifications outside the app (push, email). Customisable dashboards or widget ordering.

## Design notes

- Activity is engine output and may carry user content (agent and file names): text only, never markdown or HTML; links are built from IDs with the router's typed `Link`, never from strings in the payload.
- Feed cache is bounded (keep the newest 200 items in memory); older pages are refetched on demand.
- The palette's agent search goes through the same `agentKeys` factory as U-03, so a result hover preloads the detail.
- Components from `@ptbk/ui` and tokens only; the greeting uses the display font token, counts use `Intl` number formatting.

## Acceptance criteria

- [ ] `homeVariant` unit tests: `security.read` gives the control center, any set without it the member home; a test greps the feature for role-name comparisons.
- [ ] Control center with the in-memory client: counts match `GET /runs/stats`; needs attention sums two fake `attention` providers and links to each; the update banner shows for `available` and on an `engine.update-available` event; without `runs@1` the run counts are absent, not zero.
- [ ] Member home lists only the member's queued and running runs (request carries `createdBy` and `status`).
- [ ] Activity: an emitted event prepends a card without a refetch (client call count unchanged); while scrolled down it shows "N new" instead; the live region announces once per batch; a member without `runs.read` sees no `run.*` cards or chips.
- [ ] Renderer lookup: exact beats prefix beats fallback; an unknown kind, a higher `v` and an `invalid` item each render the fallback card with the raw kind as text; an activity whose agent name contains `<img src=x onerror=alert(1)>` renders it literally.
- [ ] Palette: ⌘K and Ctrl+K open it, the header button opens it, `Esc` closes and returns focus; typing finds a seeded agent and Enter navigates; a command whose permission is missing is absent; `axe-core` passes on the open palette.
- [ ] Empty, error (per widget) and loading states each have a test; reduced motion replaces the slide-in with a fade.
- [ ] `test:csp` visits `/` as owner and as a member with zero violations and passes the UX checks (360 px without overflow, layout shift, reduced motion); `/` stays within its recorded bundle budget.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- `security.read` as the switch for the control center is a heuristic; if the engine team adds an explicit permission for engine oversight, switch to it in `homeVariant` only.
- C-04's agent list may not return a total; the agents count is then omitted rather than computed by paging.
- Recent chats across agents need a chat list endpoint not scoped to one agent; amend C-04 if it is missing, else show recent agents only.
