# U-03. Agents: list, detail, control

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** U-02
- **Status:** in progress (feat/u-03-agents)
- **Spec:** Security hardening ("None of this limits the owner", 1 on public agents), What our platform can and cannot do; ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md), [0015](../../adr/0015-ui-architecture-and-design-system.md), [0016](../../adr/0016-engine-capabilities.md)

## Goal

The owner sees every agent on the engine, can search and page through them, sees each one's status and visibility, and can start, stop, make public or private, and delete any agent; the agent detail page is assembled from tabs that feature modules register, so capabilities the engine does not advertise simply do not appear.

## Context

The spec is explicit: isolation is aimed at agents, visitors and Promptbook, never at the owner. The owner must see and control all agents, including those created by other members, so nothing in this screen filters by creator: which agents a member may see is the engine's decision, and the UI shows what the API returns. v0 has one owner, but the screen must not assume it: every action is rendered by capability through `can()` from U-02, never by role name, so members with narrower roles later need no UI change. Public visibility opens an agent to anonymous visitors through the engine gateway, so it gets a confirmation. Data comes only through the `EngineApiClient` from C-04; the mock engine (M-04) seeds believable agents for dev and e2e. The agent detail follows [docs/design/ui.md](../../design/ui.md) (Overview · Chat · Runs · Files · Triggers · Integrations · Book · Settings) and is built from U-02's feature registry: this task owns the page frame and the Overview and Settings tabs; U-04 registers Book, U-05 Chat, U-09 to U-12 Runs, Files, Triggers and Integrations.

## Scope

- Routes:
  - `/agents`: list. Search params validated with zod in `validateSearch`: `q` (string), `status` (C-04's run state: `idle | running | stopped | error`), `visibility`, `sort` (`name` | `updatedAt` | `createdAt`, `-` prefix for descending, default `-updatedAt`), `cursor`. All of them are sent to C-04's `GET /agents`; nothing is sorted or filtered on the client. The URL is the state, so back and forward work and links are shareable.
  - `/agents/$agentId` (layout route) with one child route per registered tab at `/agents/$agentId/<tab>`; the index is Overview. Header: avatar, name, description, live status, primary actions (Chat, Edit, Stop, each by `can()`).
- Agent tabs from the registry (`agentTabs` of every entry in `FEATURES`, U-02): sorted by `order`, each shown only when its feature's and its own `requires` (capability via `useEngineCapabilities()`, permission via `can()`) are met; a tab route's `beforeLoad` calls `requireFeature(id)`, so a deep link to a hidden tab shows "not available on this engine" or "no access", never a crash. Tabs use `@ptbk/ui` `Tabs` bound to the URL (each tab a link that preloads on intent); below 768 px the tab list scrolls inside its own container, so the page never overflows at 360 px.
- This task registers the `agents` feature (`nav` in the work group, commands "Go to agent" and "New agent") with two tabs:
  - **Overview:** identity, status, visibility, owner/creator, created and updated times, last activity, model, then the registered `agentOverviewCards` in `order` (recent runs, triggers, integrations and knowledge come from U-09 to U-12), each filtered by its `requires` and rendered in its own error boundary so one failing card does not blank the page.
  - **Settings:** visibility and delete (the actions below), guarded by `agents.write` or `agents.delete`; the tab is hidden when the member holds neither.
- List: `DataTable` from `@ptbk/ui` in server-side mode, its sorting, filters and cursor bound to the typed search params above; its card layout below 768 px. Columns: name (link), description (truncated), status badge, visibility badge, created by, last activity (`RelativeTime`); column visibility from the table menu, persisted per device. Debounced search (300 ms), status and visibility filters, cursor paging with previous/next, total count when the API provides it. Row selection stays off (no bulk actions). Row actions in the table's actions menu. "New agent" button to `/agents/new` (route added by U-04; until then a stub).
- Status: `useAgentLiveState(agentId)` resolves the registered `agentStatusProvider`: when the engine advertises `runs@1` and the member holds `runs.read`, U-09's provider derives the state from runs; otherwise this task's fallback provider uses C-04's draft `GET /agents/{id}/status`. The agent record stores no running state of its own. Badge with text (running, idle, stopped, error, as C-04 defines, plus the provider's states). The fallback is driven by C-04's `GET /events` SSE: one app-wide subscription (`src/app/engine-events.ts`, resumable with `Last-Event-ID`; U-05 reuses it) writes each `agent.status` event into the cached status of that agent in list and detail with `setQueryData`, and `agent.changed` invalidates that agent's detail and the list. If the stream cannot resume, the agent queries are invalidated once on reconnect. Nothing polls.
- Actions on detail and in the row menu: start, stop, toggle visibility, delete.
  - Visibility to public: `ConfirmDialog` explaining that anyone with the link can chat with the agent without signing in.
  - Delete: `ConfirmDialog` requiring the agent's name to be typed; then navigate to `/agents` and show a toast.
  - Each action is shown only when `can()` allows it: `agents.write` (create, change visibility or folder), `agents.run` (start and stop; draft in C-04), `agents.delete` (exact names from C-04). A hidden action that the API still refuses with 403 shows "not allowed".
  - Mutations use `useStepUpAwareMutation` (U-02). Visibility toggles optimistically in list and detail with rollback on error; delete and start/stop wait for the server. Every outcome is reported with a toast (success and failure).
- Hooks in `src/features/agents/`: `useAgentList(params)`, `useAgent(id)`, `useAgentMutations()`, query-key factory `agentKeys` and `queryOptions` helpers shared with the route loaders. Mutations invalidate list and detail.
- States: loading skeletons shaped like rows and the detail layout, empty (no agents yet, with a call to action), no search results, API error state with retry, agent not found (404 from API); anything else falls to the route error boundary (U-02).
- Translations for every string in `cs` and `en`.

## Out of scope

- Creating agents and editing the book (U-04). Chat (U-05). The Runs, Files, Triggers and Integrations tabs and their overview cards (U-09 to U-12).
- Bulk actions, tags, folders. Member management (U-06).

## Design notes

- `useAgentList` keeps the previous page visible while the next loads (`placeholderData: keepPreviousData`).
- Route loaders prefetch list and detail with `ensureQueryData` so navigation shows data without a spinner when cached; with the router's intent preloading (U-01), hovering or focusing a row link loads the detail before the click.
- Agent names and descriptions are user content: render them as text only, never as markdown or HTML.
- The page frame never imports a tab's code: tabs and cards are reached only through the registry, so each stays in its own route chunk and a missing feature leaves no dead code path.
- If the API returns an agent status the UI does not know, show it as "unknown" with the raw value as text; the exhaustive `switch` over the known union plus a fallback for forward compatibility.

## Acceptance criteria

- [ ] Unit tests with the in-memory client seeded with 120 agents, including agents created by a second member:
  - [ ] all 120 are reachable through paging; the second member's agents appear without any filter;
  - [ ] search narrows the list and writes `q` to the URL; reloading the URL restores the same view;
  - [ ] status and visibility filters combine with search;
  - [ ] invalid search params (unknown `status`, garbage `cursor`) fall back to defaults instead of crashing.
- [ ] Delete: the confirm button stays disabled until the exact name is typed; on success the agent is gone from the list; on API error the banner shows, the agent stays, and the dialog can be retried.
- [ ] Visibility: making an agent public requires confirmation; a failed toggle rolls back the badge.
- [ ] Start/stop update the status badge after the server confirms.
- [ ] A step-up-required error on delete opens the step-up dialog (U-02).
- [ ] An `agent.status` event from the in-memory client's event stream updates the badge in list and detail without a refetch (client call count unchanged).
- [ ] Sorting writes `sort` to the URL and the request carries it; reloading keeps the order.
- [ ] With a permission list lacking `agents.delete` and `agents.write`, delete and the visibility toggle are absent from detail and row menu; with only `agents.read`, the "New agent" button is absent too.
- [ ] Tabs: with all four capabilities advertised and full permissions, the eight tabs appear in the order of [docs/design/ui.md](../../design/ui.md); with `capabilities: []` only Overview, Chat, Book and Settings appear; without `runs.read` the Runs tab is hidden and `/agents/$agentId/runs` shows "no access"; a test feature registered in `FEATURES` adds a tab and an overview card without changes to this feature's code.
- [ ] Status: with `runs@1` advertised the badge follows the registered provider (a fake provider in the test changes it); without it, it follows the draft status endpoint and `agent.status` events.
- [ ] An overview card that throws shows its own error state while the rest of the overview renders.
- [ ] Empty, no-results, error and not-found states each have a test.
- [ ] Hovering a row link fetches the agent detail once before navigation (in-memory client call count); a hidden column stays hidden after reload.
- [ ] Each mutation shows a success or failure toast; a failed visibility toggle shows the failure toast and the rolled-back badge.
- [ ] `axe-core` reports no violations on list and detail; every action is reachable by keyboard and dialogs return focus to the triggering control.
- [ ] `test:csp` visits `/agents`, `/agents/$agentId` and its Settings tab with zero violations and passes the UX checks (360 px without overflow, layout shift, reduced motion); both routes stay within their bundle budgets.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Run control (start, stop, status, `agents.run`) is draft in C-04 and may change with the engine team; keep it inside `useAgentMutations` and the fallback status provider so a change touches one place. Once the engine ships `runs@1`, the draft endpoint may disappear; the fallback then shows status as unknown.
- Whether public agents are allowed on the default engine domain is open in the spec. The UI shows the toggle; the engine decides whether to accept it, and a refusal is shown as an error message.
- Whether delete needs step-up is the engine's policy; the UI must handle both.
