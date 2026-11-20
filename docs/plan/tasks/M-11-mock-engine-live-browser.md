# M-11. Mock engine: live browser behind a dev flag

- **Lane:** M · **Module:** `apps/mock-engine` · **Milestone:** M5
- **Depends on:** C-16
- **Status:** in progress (feat/m-11-mock-live-browser)
- **Spec:** Access, transport and zero trust; ADR [0019](../../adr/0019-live-sessions-inside-the-tunnel.md)

## Goal

The UI lane and e2e can try the live browser end to end against the mock engine, while no environment advertises it by accident.

## Scope

- `MOCK_LIVE_BROWSER=enabled` advertises `browser-tab@1`; off by default, refused with `NODE_ENV=production` like the other dev switches.
- The live channel at `/api/v1/live-sessions/{sessionId}/channel` over the mock's WebSocket support: gateway session cookie, `Origin` check, `ptbk-live` subprotocol, no token in the URL.
- A synthetic screencast from the reference engine's fake browser (PNG frames, no new dependency), a fake agent tab, timers for expiry, idle and frame pacing.
- Control levers: `POST /__mock/live-browser/help-requests` raises a help request on the fake agent tab (or a named one); `POST /__mock/live-browser/navigate` moves a tab to another origin, a browser page or a secret page; `POST /__mock/live-browser/tabs` opens an agent tab; `POST /__mock/live-browser/elapse` ends a session early; `POST /__mock/sessions` with `stepUp: 'stale'`.
- The conformance target wires the channel and the levers.

## Out of scope

- A real browser; the UI.

## Acceptance criteria

- [x] Without the flag, `GET /engine` does not advertise `browser-tab@1` and the routes answer 404 `capability-not-supported`.
- [ ] With it, the engine-api conformance suite's browser-tab checks pass against the mock engine.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.
