# U-09. Runs: timeline, run detail, cancel and retry

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** U-02, C-07
- **Status:** done (#50)
- **Spec:** Security hardening (preamble "None of this limits the owner", 5 agent output is untrusted, 6 tool calls never become code), Enterprise-ready engine architecture (Authorisation); ADRs: [0015](../../adr/0015-ui-architecture-and-design-system.md), [0016](../../adr/0016-engine-capabilities.md)

## Goal

Owners and permitted members see all agent work as runs, across agents and per agent, open any run to see its steps, tool calls, usage, errors and outputs (including project changes with a diff), and cancel or retry it in one or two steps, with live updates and no polling.

## Context

"Calm control" ([docs/design/ui.md](../../design/ui.md)): an owner sees everything agents do and can stop anything quickly. A run is one unit of agent work, whatever started it (C-07's `runs@1`: chat turn, API, email, schedule, member, goal). Runs and their actions are mobile-first in the brief, because an owner often checks or stops work from a phone. Logs, tool output and diffs come from agents and are attacker-controlled once an agent reads external content, so they render as text only. This module also feeds the rest of the app through the registry (U-02): the agent status (U-03), the home's live feed, counts and attention items (U-08), the shell's live indicator and the command palette.

## Scope

- Feature module `src/features/runs/` with one `defineFeature({ id: 'runs', requires: { capability: runs@1, permission: 'runs.read' } })` entry in `FEATURES` registering:
  - `nav`: Runs in the `work` group; `agentTabs`: Runs at `/agents/$agentId/runs`; `agentOverviewCards`: recent runs (last five, link to the tab);
  - `activityRenderers` for `run.*` (v1): queued, started, completed (duration, cost when known), failed (error summary), cancelled, each with a link to the run;
  - `attention`: `failedLast24h` from C-07's `GET /runs/stats`, linking to `/runs?status=failed`; `liveIndicator`: `running` from the same stats;
  - `agentStatusProvider`: `useAgentLiveState(agentId)` derived from `GET /runs/stats?agentId` and `run.changed` events: `running` (any running), `queued`, `failed-recently` (failed in the last 24 h and nothing since), else `idle`;
  - `commands`: "Go to run" (searches recent runs) and "Stop run" (lists active runs, requires `runs.control`).
- Routes, each with `beforeLoad: requireFeature('runs')`:
  - `/runs`: global timeline. Search params in `validateSearch` with `.catch()` defaults: `agentId`, `status` (set of C-07 statuses), `source`, `from`, `to`, `cursor`. `DataTable` in server-side mode bound to them; columns: status badge (text, not colour alone), agent, source, title (progress title or first message), queued, duration (live for running runs), cost; cards below 768 px. Newest first; nothing filtered on the client.
  - `/agents/$agentId/runs`: the same table scoped to the agent, agent column hidden.
  - `/runs/$runId`: detail. Header: status, source (linked to the chat message or trigger when present), agent, queued, started, completed, attempt, runner and model. Then sections as `Card`s:
    - **Steps:** C-07's progress card (`title`, `now`, `next`, items with pending or completed state), live while running.
    - **Tool calls:** collapsible rows (name, state `pending | partial | complete | error`, duration); expanded logs in a `<pre>` as text, with a "truncated by the engine" notice when `logsTruncated`.
    - **Usage and cost:** input and output tokens, duration, cost through `@ptbk/ui`'s `Intl` currency formatter from the decimal string; each shows "unknown" when `null`.
    - **Error:** `Banner` with code and summary for failed runs.
    - **Outputs:** messages linked to the chat (U-05 route); files linked to U-10's detail when `files@1` is advertised, else names only; project changes per project with commit hash as `CodeText` with `CopyButton`, a changed-files table (path, insertions, deletions, as text and sign, not colour only) and a diff viewer.
- Diff viewer (`src/features/runs/diff-view.tsx`): splits the unified diff text into lines and renders each as a React text node with a class for added, removed, hunk or context lines (classes from component tokens in `app.css`); no HTML parsing, no syntax highlighting in this task; virtualised with `@tanstack/react-virtual` (through `@ptbk/ui`) above about 1,000 lines; a notice with the engine's truncation when `diffTruncated`.
- Actions, rendered through `can('runs.control')`, on the detail page (sticky action bar at the bottom below 768 px) and in the row menu:
  - Cancel (queued or running): one step, no dialog; optimistic "Cancelling…" from `cancelRequestedAt`, rolled back with an error toast on failure; 409 `run-finished` refetches the run and says it already finished.
  - Retry (failed only): creates the new run, navigates to it and shows a toast; never optimistic.
  - Both through `useStepUpAwareMutation` (U-02); a 403 shows "not allowed".
- Live updates: the app-wide `/events` subscription (U-03) routes `run.changed` to `setQueryData` for a cached run's status and invalidates its detail, the lists and stats; `activity` events are handled by U-08. Elapsed time for running runs comes from one shared ticking clock hook (one interval for the whole app, paused when the tab is hidden), never from refetching. Nothing polls.
- Hooks: `runKeys`, `runListQueryOptions(params)`, `runQueryOptions(id)`, `runStatsQueryOptions(agentId?)`, `useRunMutations()`, shared with the loaders.
- States: skeletons shaped like rows and the detail sections, empty ("No runs yet", per agent and global), no results for filters, error with retry per detail section, run not found; route error boundary for the rest (U-02). Motion from tokens: a completed run settles, a running badge breathes subtly; reduced motion turns both off.

## Out of scope

- Starting runs from this screen (a chat message or a trigger starts one, C-07). Files and triggers screens (U-10, U-11). The home feed and fallback activity card (U-08).
- Syntax-highlighted or side-by-side diffs, full log download (later).

## Design notes

- Only `@ptbk/ui` components and semantic or component tokens; new run-specific tokens (`--run-diff-added-bg` …) default to semantic ones.
- Unknown statuses or sources from a newer engine render as "unknown" with the raw value; label maps are lookups with fallback.
- Cost totals are never summed in floating point; show per-run values as the engine reports them.

## Acceptance criteria

- [ ] With the in-memory client (C-07 seed): paging, filters by status set, source, agent and date are written to the URL and restored on reload; invalid params fall back to defaults; the per-agent tab shows only that agent's runs.
- [ ] Detail renders every section for a completed run with project changes, a failed run with an error, and a running run whose steps and elapsed time update from controller-advanced events without any extra list or detail fetch (client call count).
- [ ] Hostile content: tool logs, error summaries and a diff containing `<img src=x onerror=alert(1)>`, `<script>` and a `javascript:` URL render as literal text; no `img`, `script` or `a[href]` appears; a 20,000-line diff mounts only the visible window and shows the truncation notice when flagged.
- [ ] Cancel: optimistic state, rollback and error toast on failure, 409 `run-finished` message; retry only offered for `failed` and navigates to the new run.
- [ ] Without `runs.control` no cancel or retry control exists; without `runs.read` or without `runs@1` the nav item, agent tab, overview card, attention item and commands are absent and `/runs` shows "no access" or "not available on this engine".
- [ ] `agentStatusProvider` returns running, queued, failed-recently and idle for matching seeded stats and switches on a `run.changed` event; each `run.*` renderer renders its v1 payload.
- [ ] Usage with `null` fields shows "unknown"; cost is formatted in both locales.
- [ ] Empty, no-results, error and not-found states each have a test; `axe-core` passes on list and detail; every action works by keyboard.
- [ ] `test:csp` visits `/runs`, `/agents/$agentId/runs` and `/runs/$runId` with zero violations and passes the UX checks (360 px without overflow with the sticky action bar visible, layout shift, reduced motion); each route stays within its bundle budget.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- `failed-recently` and its 24-hour window are a UI choice on top of C-07's stats; confirm with Seb before the visual pass.
- Large diffs and logs depend on the engine honouring `MAX_RUN_TEXT_BYTES`; if real runs need more, add a paged log endpoint to C-07 rather than raising the limit.
