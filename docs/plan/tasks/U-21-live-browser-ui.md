# U-21. Live browser in the UI: watch and take over the engine's browser tab

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M5
- **Depends on:** C-16 (M-11 for the browser check against the mock engine)
- **Status:** done (#347)
- **Spec:** Security hardening; ADRs: [0015](../../adr/0015-ui-architecture-and-design-system.md), [0016](../../adr/0016-engine-capabilities.md), [0019](../../adr/0019-live-sessions-inside-the-tunnel.md)
- **Design:** [ui.md](../../design/ui.md), [live-sessions.md](../../engine-integration/live-sessions.md)

## Goal

The engine UI builds `browser-tab@1` from C-16: members watch the tab an agent works in, the owner takes it over behind step-up and hands it back, answers an agent's request for help in one click, and opens a fresh tab to sign in to a site. Issue #331. Prepared, not rolled out: without `browser-tab@1` nothing of it appears.

## Context

The contract (`capabilities/live.ts`, `live-channel.ts`), the typed client's `client.browser.*` and the in-memory reference engine come from C-16. Frames and input flow over one WebSocket on the engine origin (`/api/v1/live-sessions/{id}/channel`, subprotocol `ptbk-live`), authenticated by the session cookie; `ENGINE_UI_CSP` does not change.

Decisions (Seb, 2026-11-20): prepare it, don't roll it out; show it only when the engine advertises `browser-tab@1`; secure and working well; calm and uncluttered, destructive actions in overflow menus, quiet trust copy.

## Scope

- **Viewer**: frames drawn to a `<canvas>` with `createImageBitmap` (no `blob:` images, no inline styles, CSP unchanged), a `frame-ack` per frame, tab CSS px scaled to the canvas, the tab's origin as the engine reports it, and the connection state (connecting, watching, controlling, agent paused, blocked, ended with its reason). It reconnects within the session.
- **Watch and control**: members with `browser.watch` watch read-only and send no input. The owner takes control through the existing step-up; the agent shows as paused. Pointer, wheel and the closed key set go out as `LiveInputEvent` only while controlling and not blocked. Hand back returns control; End is in the overflow menu. Never clipboard, files or JavaScript; typed text is never logged, kept in state or in query caches.
- **Persistent indicator** in the shell while a session is live ("You're controlling the agent's browser on example.com", "Watching…") with an end control.
- **Help requests** on Home's "Needs you" and on the related chat or run: reason, origin and the agent's message as text only; one click joins in control (step-up), then hand back; Dismiss in the overflow menu. Driven by `browser-help.changed`.
- **Sign-in tab**: the owner opens a fresh tab at an allowed origin from the Wallet.
- **Narration seam**: the viewer shows the tab's linked work (agent, chat, run) and the run's current state; a narration channel is out of scope.
- en and cs copy; unit and component tests against the in-memory engine; `test:csp` drives the viewer with real frames under the engine CSP. The viewer loads lazily so the entry barely grows.

## Out of scope

- The mock engine (M-11), the engine's implementation, live audio and video.
- Rolling it out: no environment advertises `browser-tab@1`.

## Acceptance criteria

- [x] Tests: watch sends no input; control after step-up; hand back; a blocked origin shows its state and sends no input; `frame-ack` per frame; each end reason; no capability renders nothing; no typed text in the query or mutation caches.
- [x] `bun run check` and `test:csp` pass with no CSP or Trusted Types violation.
- [x] Screenshots of the main states (en) are in the PR.
- [x] **Status** line above set to `done (#<PR>)`.
