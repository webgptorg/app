# C-16. Live browser contract: watch and take over the engine's browser tab

- **Lane:** C · **Module:** `packages/engine-api`, `packages/conformance` · **Milestone:** M5
- **Depends on:** C-15
- **Status:** in progress (feat/c-16-live-browser-contract)
- **Spec:** Access, transport and zero trust; ADRs: [0016](../../adr/0016-engine-capabilities.md), [0019](../../adr/0019-live-sessions-inside-the-tunnel.md)

## Goal

`browser-tab@1` becomes a real draft capability that the engine team can implement from the contract alone: a member watches the tab an agent works in, the owner takes it over mid-task (captcha, login, a stuck step) or opens a fresh sign-in tab, and an agent that is stuck asks for help and learns how the human's session ended. Issue #331. Nothing is rolled out: no real environment advertises it.

## Context

ADR 0019 (Proposed, 2026-11-05) reserved the capability with one inert route and left the channel format open. Seb's decisions of 2026-11-20 widen the scope and accept the transport as designed (one WebSocket inside the engine's TLS, no tunnel or relay change, `ENGINE_UI_CSP` unchanged). Contract changes go in place before E-02, with an AGENT_BRIEF entry.

Decisions (Seb, 2026-11-20):

- Two attachments: (a) a fresh sign-in tab at an allowlisted origin, owner only with step-up; (b) an agent's tab, to watch it or take it over. While a human controls it the agent pauses; handing back resumes it.
- Permissions: `browser.watch` (members who can see the chat or task) and `browser.control` (owner, step-up). One controller at a time, a small cap on watchers.
- Agents: (i) help requests, built; (ii) live narration, designed only through links to the run, chat and task; (iii) structured outcomes for the agent, defined on the help request's resolution.

## Scope

- `capabilities/live.ts`: `browser-tab@1` moves from `RESERVED_CAPABILITIES` to `KNOWN_CAPABILITIES` (routes stay `draft`). Routes: open a sign-in session; list agent tabs; watch or take over a tab; take control and hand back; end; read a session; help requests (list, read, dismiss); `browser-tab.changed` and `browser-help.changed` events.
- The channel: strict control messages per direction (`hello`, `state`, `view`, `frame-ack`, `input`, `input-refused`, `navigated`, `blocked`, `end`), closed input events and keys, and pure encode/decode of the binary media header with the 64 KiB cap.
- Problem codes, permission `browser.watch`, audit actions (metadata only).
- The in-memory reference engine implements it with a fake browser (real PNG frames, no dependency) and a channel port the mock engine and the conformance fake attach to.
- Conformance: real checks when `browser-tab@1` is advertised (auth, step-up, watcher input, single controller, blocked origin, input refusals, 64 KiB cap, expiry and idle, audit without typed text, help request lifecycle), each with a failing case. `live-audio` and `live-video` stay reserved.
- Docs: ADR 0019 Accepted with revisions, live-sessions.md rewritten, engine-api.md, AGENT_BRIEF entry with test cases LB-01…, checklist rows.

## Out of scope

- The mock engine (M-11) and the UI (a separate lane).
- Live audio and video, WebRTC, any tunnel or relay change.
- Narration as a new channel; it reuses run and chat events.

## Acceptance criteria

- [x] Strict in, tolerant out for every new schema; refusal tests for every message and input kind.
- [x] The reference engine enforces: session bound to the gateway session (others get 404), one attachment per participant, exclusive control, frames stop and input drops on blocked pages, no typed text in the audit log, expiry, idle end, revocation ends the session.
- [x] Conformance checks pass against the in-memory engine and fail against a fake that breaks each rule.
- [ ] `engine-api` and `protocol` coverage thresholds hold; `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Timers are not testable black-box within a conformance run; expiry and idle use a test-mode lever, and the timer itself is covered by the engine's unit tests (LB cases).
