# 0019. Live audio, video and the browser tab ride inside the engine's TLS

- **Status:** Accepted (revised 2026-11-20)
- **Date:** 2026-11-05; revised 2026-11-20

## Context

The Reborn app contract defers remote full-duplex audio, later video, and remote interaction with an engine browser tab, but asks that the connection be designed for them now, under the same boundary as everything else: relays and the dashboard never see the content (the engine's `specs/app/integration.md`, "Explicitly deferred, designed for now"). On 2026-11-05 Seb decided to prepare the contract and transport and build nothing user-facing (Reborn alignment, decision 8). The zero-trust spec already expects a screencast through the relay and names a later WebRTC path.

On 2026-11-20 Seb widened the browser tab (issue #331): besides a fresh tab for a manual sign-in, members watch the tab an agent works in and the owner takes it over mid-task (a captcha, a login, a stuck step), and an agent that is stuck asks for help. The pieces are prepared now; the capability stays unadvertised on every real environment until it is rolled out.

## Decision

- **Transport, unchanged from 2026-11-05.** A live session is opened with an ordinary engine API call and carried by one WebSocket at `/api/v1/live-sessions/{id}/channel` on the engine origin, inside the browser's own TLS connection to the engine. It authenticates with the gateway session cookie, the gateway checks `Origin`, and nothing goes in the URL. No WebRTC, STUN or TURN, no tunnel frame types, stream kinds or relay change: the relay stays content-blind and cannot tell a screencast from a page load except by traffic shape. `ENGINE_UI_CSP` stays as it is (frames are drawn to a `<canvas>` with `createImageBitmap`), and so does `Permissions-Policy`: the browser tab needs no microphone or camera.
- **`browser-tab@1` is a known, draft capability** ([live.ts](../../packages/engine-api/src/capabilities/live.ts), [live-channel.ts](../../packages/engine-api/src/capabilities/live-channel.ts)). `live-audio@1` and `live-video@1` stay reserved and untouched.
- **Two attachments.** (a) A **sign-in** session: a new tab at an allowlisted origin, owner only, behind step-up. (b) An **agent-tab** session on the tab an agent works in: watching it, or taking control of it. While a human controls the tab the agent pauses; handing back resumes it.
- **Permissions, kept separate because they may change.** `browser.watch` (members who can see the chat, task or run the tab belongs to) and `browser.control` (owner only by engine policy, every route that grants it behind step-up). One controller per tab, at most `MAX_BROWSER_PARTICIPANTS` (5) sessions on it.
- **A session belongs to the gateway session that opened it**: any other one gets 404, only it attaches the channel, once at a time.
- **Agents.** (i) Help requests are built: an agent stuck on a login, captcha, confirmation or blocked page raises one, the owner takes control with one click, and the agent waits for a structured outcome. (ii) Narration is designed only: a tab carries the `agentId`, `chatId`, `taskId` and `runId` of its work, so the UI shows that work's existing run and chat events next to the stream; there is no new narration channel. (iii) What the agent learns is the help request's resolution: an outcome from a closed set (`handed-back`, `ended`, `expired`, `idle`, `blocked-origin`, `dismissed`, `revoked`, `cancelled`) and the tab's origin, never frames, input or typed text.
- **The channel format is fixed** with `browser-tab@1`: strict JSON control messages per direction, a closed set of input events and keys in tab coordinates (no clipboard, file chooser, downloads, JavaScript or CDP from the client, no modifier but Shift), navigation reported as an origin only, and binary media with a 13-byte header and a 64 KiB cap per message.
- **Bounded and blocked.** `MAX_BROWSER_TAB_SESSION_MS` (10 minutes) per session, `BROWSER_IDLE_MS` (2 minutes) without input ends a controller's session, frames stop and input is dropped on browser-internal, Wallet and secret pages and on origins outside the allowlist while a human controls the tab. The audit log holds metadata only.

## Consequences

- Live sessions inherit end-to-end TLS, the gateway session, origin checks, audit and relay fairness without new mechanisms, and the relay stays content-blind.
- Media shares TCP with everything else: screencast bandwidth counts against the engine's relay budget, and loss delays frames. We measure latency through a relay before rolling out; a WebRTC path with its DTLS fingerprint pinned through the live channel stays the escape hatch, as a new ADR.
- The engine team implements the browser tab from the contract, the in-memory reference engine and the conformance checks (AGENT_BRIEF, 2026-11-20). What stays open for them is listed in [live-sessions.md](../engine-integration/live-sessions.md#still-open-for-the-engine-team): the exact allowlist rule for identity-provider redirects, how the engine names browsers, and the screencast settings.
- Audio and video keep the 2026-11-05 design and formats, unbuilt; they reuse the channel format (media kinds 16–47 are kept for them).
