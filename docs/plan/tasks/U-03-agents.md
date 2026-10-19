# U-03. Agents: list, detail, control

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** U-02
- **Status:** todo
- **Spec:** Security hardening ("None of this limits the owner", 1 on public agents), What our platform can and cannot do; ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md)

## Goal

The owner sees every agent on the engine, can search and page through them, sees each one's status and visibility, and can start, stop, make public or private, and delete any agent.

## Context

The spec is explicit: isolation is aimed at agents, visitors and Promptbook, never at the owner. The owner must see and control all agents, including those created by other members, so nothing in this screen filters by creator: which agents a member may see is the engine's decision, and the UI shows what the API returns. v0 has one owner, but the screen must not assume it: every action is rendered by capability through `can()` from U-02, never by role name, so members with narrower roles later need no UI change. Public visibility opens an agent to anonymous visitors through the engine gateway, so it gets a confirmation. Data comes only through the `EngineApiClient` from C-04; the mock engine (M-04) seeds believable agents for dev and e2e.

## Scope

- Routes:
  - `/agents`: list. Search params validated with zod in `validateSearch`: `q` (string), `status` (C-04's run state: `idle | running | stopped | error`), `visibility`, `sort` (`name` | `updatedAt` | `createdAt`, `-` prefix for descending, default `-updatedAt`), `cursor`. All of them are sent to C-04's `GET /agents`; nothing is sorted or filtered on the client. The URL is the state, so back and forward work and links are shareable.
  - `/agents/$agentId`: detail with overview, status, visibility, owner/creator, created and updated times, last activity, model, and links to chat (U-05) and the book editor (U-04).
- List: `DataTable` from `@ptbk/ui` in server-side mode, its sorting, filters and cursor bound to the typed search params above; its card layout below 768 px. Columns: name (link), description (truncated), status badge, visibility badge, created by, last activity (`RelativeTime`); column visibility from the table menu, persisted per device. Debounced search (300 ms), status and visibility filters, cursor paging with previous/next, total count when the API provides it. Row selection stays off (no bulk actions). Row actions in the table's actions menu. "New agent" button to `/agents/new` (route added by U-04; until then a stub).
- Status: badge with text (running, idle, stopped, error, as C-04 defines). Driven by C-04's `GET /events` SSE: one app-wide subscription (`src/app/engine-events.ts`, resumable with `Last-Event-ID`; U-05 reuses it) writes each `agent.status` event into the cached status of that agent in list and detail with `setQueryData`, and `agent.changed` invalidates that agent's detail and the list. If the stream cannot resume, the agent queries are invalidated once on reconnect. Nothing polls.
- Actions on detail and in the row menu: start, stop, toggle visibility, delete.
  - Visibility to public: `ConfirmDialog` explaining that anyone with the link can chat with the agent without signing in.
  - Delete: `ConfirmDialog` requiring the agent's name to be typed; then navigate to `/agents` and show a toast.
  - Each action is shown only when `can()` allows it: `agents.write` (create, change visibility or folder), `agents.run` (start and stop; draft in C-04), `agents.delete` (exact names from C-04). A hidden action that the API still refuses with 403 shows "not allowed".
  - Mutations use `useStepUpAwareMutation` (U-02). Visibility toggles optimistically in list and detail with rollback on error; delete and start/stop wait for the server. Every outcome is reported with a toast (success and failure).
- Hooks in `src/features/agents/`: `useAgentList(params)`, `useAgent(id)`, `useAgentMutations()`, query-key factory `agentKeys` and `queryOptions` helpers shared with the route loaders. Mutations invalidate list and detail.
- States: loading skeletons shaped like rows and the detail layout, empty (no agents yet, with a call to action), no search results, API error state with retry, agent not found (404 from API); anything else falls to the route error boundary (U-02).
- Translations for every string in `cs` and `en`.

## Out of scope

- Creating agents and editing the book (U-04). Chat (U-05).
- Bulk actions, tags, folders. Member management (U-06).

## Design notes

- `useAgentList` keeps the previous page visible while the next loads (`placeholderData: keepPreviousData`).
- Route loaders prefetch list and detail with `ensureQueryData` so navigation shows data without a spinner when cached; with the router's intent preloading (U-01), hovering or focusing a row link loads the detail before the click.
- Agent names and descriptions are user content: render them as text only, never as markdown or HTML.
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
- [ ] Empty, no-results, error and not-found states each have a test.
- [ ] Hovering a row link fetches the agent detail once before navigation (in-memory client call count); a hidden column stays hidden after reload.
- [ ] Each mutation shows a success or failure toast; a failed visibility toggle shows the failure toast and the rolled-back badge.
- [ ] `axe-core` reports no violations on list and detail; every action is reachable by keyboard and dialogs return focus to the triggering control.
- [ ] `test:csp` visits `/agents` and `/agents/$agentId` with zero violations and passes the UX checks (360 px without overflow, layout shift, reduced motion); both routes stay within their bundle budgets.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Run control (start, stop, status, `agents.run`) is draft in C-04 and may change with the engine team; keep it inside `useAgentMutations` and the status hook so a change touches one place.
- Whether public agents are allowed on the default engine domain is open in the spec. The UI shows the toggle; the engine decides whether to accept it, and a refusal is shown as an error message.
- Whether delete needs step-up is the engine's policy; the UI must handle both.
