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

## Out of scope

- Changes to the engine-api chat contract unless the decision needs a draft-chat endpoint; that is a contract change (C lane) first.

## Acceptance criteria

- [ ] The decision is recorded and the test chat works under the engine CSP, with tests.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Needs a human decision before implementation starts.
