# C-14. Chat activity: steps, working agents, linked tasks, rechecks

- **Lane:** C · **Module:** `packages/engine-api`, `packages/conformance` · **Milestone:** M5
- **Depends on:** —
- **Status:** in progress (feat/c-14-chat-activity)
- **Spec:** Security hardening (5 agent output is untrusted); ADRs: [0010](../../adr/0010-protocol-design-principles.md)

## Goal

A thread tells the UI what its agents are doing, not just what they wrote: an agent's turn as `progress` steps and a `final` reply, who is working right now, the tasks the thread created with their live state, and a failed reply's automatic recheck. The UI redesign (U-16) builds on it.

## Context

The Reborn engine already has all of this: `ChatDetail.messages[].phase`, `LiveReply.activity`, `ChatDetail.tasks` (`ChatTaskCard`) and `ChatDetail.recheck`. Its engine-api adapter flattens it into message text, so the UI shows tool calls as a bullet list ("- thinking:", "- Glob …", "- mcp__ptbk__create_task …") and nothing while an agent works. Contract changes are made in place with a dated AGENT_BRIEF entry until E-02.

## Scope

- `chats.ts` (done in the first commit): `ReplyStep`; `Message.phase` and `Message.steps`; `Chat.working`, `Chat.tasks` and `Chat.recheck`; the `linked` entry; `POST /chats/{chatId}/retry` with 409 `nothing-to-retry`. Readers default every new field (`null`, `[]`), so the UI keeps working against an engine from before this change.
- The in-memory engine (`packages/engine-api/src/in-memory`) produces all of it: a reply's turn saves `progress` messages with steps, then a `final` reply; `working` from the moment a turn starts; linked tasks with state changes; a failing reply sets `recheck`, and retry clears it. `chat.changed` fires on every change, at most once a second per thread for step updates.
- Demo seed: a thread that replays the 2026-11-13 Czech copywriter conversation from the demo engine (Chatter's steps, `+@User` question with the answer, `create_task`, the `linked` task, Copywriter's `Completed {…}` message with commit), plus a thread with a recheck waiting and an agent that never starts replying (for the UI's no-response state).
- Conformance: `engine-api.chats.*` checks for the new fields, the `linked` entry, the step invariant (a `tool` step names its tool), and retry (409 without a recheck).
- Docs: [engine-api.md](../../engine-integration/engine-api.md#chats) explains the fields and how the engine maps Reborn's data to them; an AGENT_BRIEF "What changed" entry tells the engine's agent what to redo; a checklist ID.

## Out of scope

- The UI (U-16). The agent status route, which is a draft the engine does not serve; the UI derives an agent's current work from the thread.

## Acceptance criteria

- [ ] Strict schemas reject a `tool` step without a tool, an unknown phase and an unknown entry field; readers accept a pre-change chat and message and default the new fields.
- [ ] The in-memory engine and mock engine pass the new conformance checks; coverage thresholds hold.
- [ ] The AGENT_BRIEF entry and engine-api.md match the schemas field for field.
