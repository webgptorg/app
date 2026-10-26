# U-14. Book editor live test chat

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** U-04, U-05
- **Status:** in progress (feat/u-14-book-test-chat)
- **Spec:** ADRs: [0013](../../adr/0013-book-editor.md), [0015](../../adr/0015-ui-architecture-and-design-system.md)

## Goal

The pro book editor has the live test chat beside it that [docs/design/ui.md](../../design/ui.md) describes, so an author can try a change to the book without publishing it.

## Context

The U-13 screenshot pass found the editor's test chat unfinished. How it should work needs a design decision first: whether a test chat runs against the unsaved draft or a saved version, whether its messages are kept, and how it fits beside CodeMirror on narrow screens.

## Scope

- A design decision on the questions above, recorded in the brief or an ADR, then the implementation.

## Decision

Made by Seb on 2026-10-26:

- **The test chat runs against the unsaved draft as typed**, without saving or publishing. Saving stays a separate, deliberate step, so trying a change never creates a revision.
- **Its messages are throwaway**: never stored by the engine or the UI (component state only, no query cache, no browser storage), gone when the panel is reset or closed or the page reloads.
- **Layout:** on wide screens a side panel beside the editor; on narrow screens a tab beside the editor (Book | Test).

That needs a draft-chat endpoint, so this task carries the additive contract change too (C lane, engine-api 1.11.0):

- **`test-chat@1`**, one route: `POST /agents/{agentId}/test-chat` with `{ book, messages }`, streaming SSE (`delta`, then one `completed` or `failed`). A capability rather than a core route, so an engine without it simply has no test panel. Agent-scoped, because the wizard tests only after the agent exists (its test step uses a real chat), and the real engine can test a draft with the agent's knowledge and settings.
- **Stateless:** every request carries the whole conversation (at most `MAX_TEST_CHAT_MESSAGES` turns and `MAX_TEST_CHAT_TRANSCRIPT_LENGTH` characters, besides a book of at most `MAX_BOOK_SOURCE_LENGTH`), and the engine stores nothing: no chat, message, revision, run or activity. Stop is closing the stream; there is no resume.
- **`agents.write`**: only someone who may edit the book may test drafts of it. A book with an error diagnostic is 422 `invalid-book` before anything streams.
- **Audit once per conversation**, as `agent.test-chat.start` on the first turn, plus every refusal. The audit log records mutations, and a test is none; but it is the only trace of a model run against a book nobody saved, so the start is recorded and the turns are not (unlike `chat.message.send`, whose chat keeps the messages anyway). No content goes into the entry.
- **Rate-limited** on its own, tighter budget (each request is a model call): the mock engine allows 60 a minute per client.
- Whether a test may call the agent's tools is engine policy, listed in the engine guide's open points.

## Out of scope

- Changes to the engine-api chat contract unless the decision needs a draft-chat endpoint; that is a contract change (C lane) first.

## Acceptance criteria

- [ ] The decision is recorded and the test chat works under the engine CSP, with tests.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Decided 2026-10-26 (see Decision). Tool use during a test run is the engine team's call.
