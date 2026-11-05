# 0019. Live audio, video and the browser tab ride inside the engine's TLS

- **Status:** Proposed
- **Date:** 2026-11-05

## Context

The Reborn app contract defers remote full-duplex audio, later video, and remote interaction with an engine browser tab for manual logins, but asks that the connection be designed for them now, under the same boundary as everything else: relays and the dashboard never see the content (the engine's `specs/app/integration.md`, "Explicitly deferred, designed for now"). Seb decided to prepare the contract and transport now and build nothing user-facing (Reborn alignment, decision 8). The zero-trust spec already expects a screencast through the relay and names a later WebRTC path.

## Decision

- A live session is opened with an ordinary engine API call and carried by one WebSocket on the engine origin, inside the browser's own TLS connection to the engine. The tunnel protocol does not change: no frame types, stream kinds or tunnel features for media, so the relay cannot tell a call from a page load except by traffic shape.
- The capabilities `live-audio@1`, `live-video@1` and `browser-tab@1` are reserved in `RESERVED_CAPABILITIES`, with `draft` routes to open audio and browser tab sessions and strict schemas. No engine may advertise them until the design in [live-sessions.md](../engine-integration/live-sessions.md) is agreed; conformance fails an engine that does.
- The browser tab is owner-only (a new `browser.control` permission), behind step-up, limited to one new tab at one allowlisted origin, never on browser-internal or Wallet entry pages, time-limited, visibly indicated and audited.
- No WebRTC, STUN or TURN for now. `ENGINE_UI_CSP` stays as it is; `Permissions-Policy` allows the microphone for the engine's own origin only once `live-audio@1` is advertised.

## Consequences

- Live sessions inherit end-to-end TLS, the gateway session, CSRF and origin checks, audit and relay fairness without new mechanisms, and the relay stays content-blind.
- Media shares TCP with everything else: loss delays audio, and screencast bandwidth counts against the engine's relay budget. We measure latency through a relay before building; a WebRTC path with its DTLS fingerprint pinned through the live channel is the escape hatch, as a new ADR.
- The channel message format, codecs and the browser tab allowlist rule are open for the engine team and get fixed in the contract with the first capability that ships.
