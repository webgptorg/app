# U-04. Create and edit agent: wizard and book editor

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** U-03, U-05
- **Status:** in progress (feat/u-04-agent-editor)
- **Spec:** Security hardening (5, 6), Engine security baseline (Browser headers); ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md), 0013 book editor (written by this task)

## Goal

The owner can create an agent with a guided wizard and edit any agent's book in a code editor with book-language highlighting, diagnostics from the engine, version history and restore, all under the engine's strict CSP.

## Context

The UX follows the predecessor "ManGo" new-agent wizard (brief, book, knowledge, test chat, done) and the predecessor book editor page. Those used Monaco from a CDN, injected `<style>` at runtime and needed `blob:` workers, all of which the engine's CSP blocks. This task picks an editor that works under the CSP and records the choice as an ADR.

**Predecessor code may be ported** (the license gate is lifted): the ManGo wizard (`promptbook`, `apps/agents-server/src/components/NewAgentDialog/ManGoNewAgentWizard/`), the book editor page (`apps/agents-server/src/app/agents/[agentName]/book/`) and the TanStack prototype (`agents-server` repo, `src/modules/onboarding/`). Port, then adapt: replace Next.js routing and server actions with TanStack Router and `EngineApiClient` calls (through TanStack Query), Tailwind 3 classes and hand-rolled controls with `@ptbk/ui` tokens and components, ad-hoc form state with the `@ptbk/ui` form layer, strings with Paraglide messages, default exports with named ones; drop CDN Monaco, runtime `<style>` injection and anything else the CSP blocks. Ported code meets [engineering.md](../../engineering.md) like new code.

## Scope

- **Editor ADR** (`docs/adr/0013-book-editor.md`, number preassigned): CodeMirror 6 versus Monaco bundled locally. Recommended: CodeMirror 6. It is modular and small, needs no workers, and its `style-mod` styles mount through constructable stylesheets (`adoptedStyleSheets`), with an `EditorView.cspNonce` fallback; `@codemirror/merge` gives the history diff. Monaco would need workers served as files (`worker-src 'self'`, no `blob:`), several Trusted Types policy names, and it creates `<style>` elements for decorations, which `style-src 'self'` blocks. The ADR cites the CSP test below as evidence.
- **Book language** in `src/features/book/language/`: a `StreamLanguage` tokenizer (first line is the agent name; lines starting with a commitment keyword such as `PERSONA`, `RULE`, `KNOWLEDGE`, `META …` are highlighted; comments, URLs and `{parameters}` too). The keyword list comes from the engine API when C-04 offers it, with a built-in fallback, so new engine commitments highlight without a UI release.
- **Diagnostics**: debounced (500 ms) call to the API's book validation, mapped to `@codemirror/lint` markers and a problems list below the editor (click jumps to the range). Stale responses are discarded (abort the previous request).
- **Wizard** at `/agents/new` (guarded by `requirePermission('agents.write')`), step in the URL (`?step=brief|book|knowledge|test|done`):
  1. Brief: name and description, a `@ptbk/ui` form with a zod schema; server validation errors from the create call are mapped onto the fields with `applyServerErrors`.
  2. Book: a draft book from the API's draft endpoint if C-04 has one, else a template filled with name and description; editable in the same editor. Leaving this step creates the agent (create call), so later steps have an agent ID; a 422 `invalid-book` keeps the user on the step with its `diagnostics` shown in the editor.
  3. Knowledge: drop zone plus an accessible file input; per-file progress, size and type limits from the API, remove before or after upload. Upload goes through the client port (it accepts `onProgress` and `signal`).
  4. Test chat: the `ChatPanel` from U-05 against the new agent.
  5. Done: links to the agent detail, chat and book editor.
  - Unsaved brief or book triggers TanStack Router's `useBlocker` on navigation. Cancelling after creation offers to delete the created agent. Nothing is written to browser storage.
- **Book editor** at `/agents/$agentId/book`: editor, problems list, save (`Mod-s` and a button) with the version the editor started from; a 409 conflict shows "changed elsewhere" with options to reload or view the diff. A 422 `invalid-book` problem carries `diagnostics` (C-04); they are shown as markers and in the problems list, and nothing is saved. History panel: list of versions (author, time; `DataTable` with cursor paging), read-only view, diff against current (`@codemirror/merge`), restore (creates a new version, never rewrites history). Save and restore wait for the server (no optimistic update: conflicts are expected) and report their outcome with a toast.
- **States and loading:** skeletons for the editor and history while loading, empty history, error states with retry, and the route error boundary for the rest (U-02). The editor and its language chunks are code-split with the route; the "Edit book" and "New agent" links preload them on intent. The editor route and the wizard get their own entries in `bundle-budget.json`, sized with the reason in the PR.

## Out of scope

- Agent list and detail (U-03). Chat internals (U-05).
- Generating books with an LLM in the UI: the engine does it, if at all.
- Rich knowledge previews (PDF rendering, embeds): file names and sizes only.

## Design notes

- Editor component `src/features/book/book-editor.tsx` owns one `EditorView`; extensions: line numbers, history, search, bracket matching, lint, the book language, a theme built from `@ptbk/ui` tokens (CSS variables, so dark mode needs no re-mount). The editor stays in engine-ui, not in `@ptbk/ui`: the dashboard does not need it.
- Highlight styles use `classHighlighter` classes styled in `app.css`, not inline themes, so the bundle CSS holds everything static.
- Uploaded files are never read into the DOM or evaluated; only metadata is shown.

## Acceptance criteria

- [ ] Editor ADR merged with status Accepted, linked from the ADR index.
- [ ] `test:csp` opens the book editor and the wizard book step under the engine CSP, types a book, sees highlighting classes and a diagnostic marker for an invalid line, opens the diff view, and records zero CSP or Trusted Types violations.
- [ ] Wizard unit tests: step validation blocks progress; the agent is created exactly once even if "Next" is double-clicked; upload progress, an over-limit file (rejected before upload) and an upload error are shown; cancel after creation offers deletion.
- [ ] Editor unit tests: diagnostics from the in-memory client appear and update; an out-of-order validation response is ignored; save sends the base version; 409 and 422 paths; restore creates a new version and the history list grows.
- [ ] Every wizard step and the editor page are keyboard-operable and pass `axe-core`; on each step change focus moves to the step heading; the drop zone has a keyboard-operable file input.
- [ ] Save and restore show success and failure toasts; loading, empty-history and error states each have a test.
- [ ] `test:csp` passes the UX checks (360 px without overflow, layout shift, reduced motion) on the wizard and the editor; both routes stay within their recorded bundle budgets.
- [ ] Ported files are listed in the PR description with their source path; none uses `innerHTML`, a CDN or a `<style>` element.
- [ ] `/agents/new` requires `agents.write` and the book editor's save and restore require `agents.write` (rendered through `can()`, guarded with `requirePermission`); a read-only member sees the book and history but no save or restore.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Contract gaps to fix in C-04 first if missing: restore of a revision, knowledge upload limits, the keyword list, a draft-book endpoint.
- Constructable stylesheets are not governed by `style-src` in current browsers; if a browser starts enforcing it, CodeMirror would need a nonce the engine does not issue. The CSP test is the tripwire.
