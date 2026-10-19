# U-03. Agents: list, detail, control

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** U-02 · **Unblocks:** U-04, X-04
- **Status:** todo
- **Spec:** Security hardening ("None of this limits the owner", 1 on public agents), What our platform can and cannot do; ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md)

## Goal

The owner sees every agent on the engine, can search and page through them, sees each one's status and visibility, and can start, stop, make public or private, and delete any agent.

## Context

The spec is explicit: isolation is aimed at agents, visitors and Promptbook, never at the owner. The owner must see and control all agents, including those created by other members, so nothing in this screen filters by creator: which agents a member may see is the engine's decision, and the UI shows what the API returns. v0 has one owner, but the screen must not assume it: every action is rendered by capability through `can()` from U-02, never by role name, so members with narrower roles later need no UI change. Public visibility opens an agent to anonymous visitors through the engine gateway, so it gets a confirmation. Data comes only through the `EngineApiClient` from C-04; the mock engine (M-04) seeds believable agents for dev and e2e.

## Scope

- Routes:
  - `/agents`: list. Search params validated with zod in `validateSearch`: `q` (string), `status`, `visibility`, `sort` (`updated` | `name`), `cursor`. The URL is the state, so back and forward work and links are shareable.
  - `/agents/$agentId`: detail with overview, status, visibility, owner/creator, created and updated times, last activity, model, and links to chat (U-05) and the book editor (U-04).
- List: `Table` on desktop, cards below 768 px. Columns: name (link), description (truncated), status badge, visibility badge, created by, last activity (`RelativeTime`). Debounced search (300 ms), status and visibility filters, cursor paging with previous/next, total count when the API provides it. "New agent" button to `/agents/new` (route added by U-04; until then a stub).
- Status: badge with text (running, idle, stopped, error, as C-04 defines). Refresh with `refetchInterval: 10_000` while the tab is visible; switch to the API's event stream if C-04 offers one.
- Actions on detail and in the row menu: start, stop, toggle visibility, delete.
  - Visibility to public: `ConfirmDialog` explaining that anyone with the link can chat with the agent without signing in.
  - Delete: `ConfirmDialog` requiring the agent's name to be typed; then navigate to `/agents` and show a toast.
  - Each action is shown only when `can()` allows it: `agents.create`, `agents.start`, `agents.stop`, `agents.update` (visibility), `agents.delete` (exact names from C-04). A hidden action that the API still refuses with 403 shows "not allowed".
  - Mutations use `useStepUpAwareMutation` (U-02). Visibility toggles optimistically with rollback on error; delete and start/stop wait for the server.
- Hooks in `src/features/agents/`: `useAgentList(params)`, `useAgent(id)`, `useAgentMutations()`, query-key factory `agentKeys`. Mutations invalidate list and detail.
- States: loading skeletons, empty (no agents yet, with a call to action), no search results, API error banner with retry, agent not found (404 from API).
- Translations for every string in `cs` and `en`.

## Out of scope

- Creating agents and editing the book (U-04). Chat (U-05).
- Bulk actions, tags, folders. Member management (U-06).

## Design notes

- `useAgentList` keeps the previous page visible while the next loads (`placeholderData: keepPreviousData`).
- Route loaders prefetch list and detail with `ensureQueryData` so navigation shows data without a spinner when cached.
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
- [ ] With a permission list lacking `agents.delete` and `agents.update`, delete and the visibility toggle are absent from detail and row menu; with only `agents.read`, the "New agent" button is absent too.
- [ ] Empty, no-results, error and not-found states each have a test.
- [ ] `axe-core` reports no violations on list and detail; every action is reachable by keyboard.
- [ ] `test:csp` visits `/agents` and `/agents/$agentId` with zero violations.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- The agent status set, the visibility values and whether the API returns a total count are C-04 decisions; if the contract lacks start/stop or creator fields, amend it first.
- Whether public agents are allowed on the default engine domain is open in the spec. The UI shows the toggle; the engine decides whether to accept it, and a refusal is shown as an error message.
- Whether delete needs step-up is the engine's policy; the UI must handle both.
