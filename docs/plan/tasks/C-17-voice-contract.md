# C-17. Voice contract: push-to-talk and spoken replies

- **Lane:** C · **Module:** `packages/engine-api`, `packages/conformance` · **Milestone:** M5
- **Depends on:** C-15
- **Status:** in progress (feat/c-17-voice-contract)
- **Spec:** Access, transport and zero trust; ADRs: [0016](../../adr/0016-engine-capabilities.md), [0019](../../adr/0019-live-sessions-inside-the-tunnel.md)

## Goal

The core of issue #332, contract first: a member speaks to an agent and hears it answer. The engine team can implement phase 1 from the contract, the reference engine and the conformance checks alone. Nothing is rolled out: no real engine advertises it, and the engine-UI recorder comes in a later lane.

## Context

ADR 0019 reserved `live-audio@1` for full-duplex voice over the live channel and left it design only. Push-to-talk needs none of that: a short clip and a spoken reply are ordinary engine API requests inside the engine's TLS. Contract changes go in place before E-02, with an AGENT_BRIEF entry.

Decisions (Seb, 2026-11-20):

- Phase 1 is built: two separate, additive capabilities, so an engine can do one without the other. `live-audio@1` and `live-video@1` stay reserved.
- A transcript is a draft. The UI puts it into the composer for the member to edit; it never sends by itself. Sending is the existing chats contract.
- The audio is not kept after transcription and never logged; the transcript is model output, rendered as text.
- `Permissions-Policy` allows `microphone=(self)` only while the engine advertises `voice-input@1`; `ENGINE_UI_CSP` does not change.
- Phase 2 (full-duplex over the live channel) is designed in live-sessions.md and typed nowhere yet: the channel types belong to C-16 (#346).

## Scope

- `capabilities/voice.ts`:
  - `voice-input@1`: `POST /chats/{chatId}/transcriptions` (`chats.write`), a raw binary body whose `Content-Type` is one of `VOICE_CLIP_FORMATS`, at most `MAX_VOICE_CLIP_BYTES` and `MAX_VOICE_CLIP_MS`, optional `?language=`; answers 200 `TranscriptDraft { text, language, confidence, durationMs }`.
  - `voice-output@1`: `POST /chats/{chatId}/messages/{messageId}/speech` (`chats.read`), body `{ formats }` from `SPEECH_FORMATS` in preference order; answers the audio in the first format the engine can make, or 415.
  - Closed problem codes: `voice-clip-too-long`, `transcription-failed`, `speech-too-long`, `message-not-speakable`, `speech-failed`, `voice-unavailable`, next to 413 `payload-too-large` and 415 `unsupported-media-type`.
- The route helper learns a `binary` request body (strict media types and a byte cap) and typed binary responses, through the fetch client, the HTTP binding, the in-memory transport, OpenAPI and the conformance client.
- Typed client methods `client.voice.transcribe` and `client.voice.speak`. No new event: a transcript changes nothing until it is sent.
- The in-memory reference engine: a deterministic fake transcriber (a fixed transcript per clip hash), a fake TTS (a generated WAV tone, no dependency), levers to fail either way or report the provider unavailable.
- Conformance, each check skipping when its capability is not advertised and failing against a fake that breaks it:
  - `engine-api.voice.transcription-caps`: size, duration and content type refusals;
  - `engine-api.voice.transcription-draft`: a draft is not a message; refusals and the audit log never echo the audio;
  - `engine-api.voice.speech`: format negotiation, 415, `speech-too-long`, unknown messages 404;
  - `engine-api.voice.permissions`: a member without `chats.write` or `chats.read` is refused;
  - `engine-api.voice.permissions-policy`: `microphone=()` without `voice-input@1`, `microphone=(self)` with it, never another origin. Runs on every engine behind a gateway.
- Docs: [voice.md](../../engine-integration/voice.md), engine-api.md, gateway.md#security-headers, live-sessions.md (phase 2 design), the AGENT_BRIEF entry of 2026-11-20 (lower priority) with test cases VO-01…, checklist rows.

## Out of scope

- The mock engine (M-12) and the engine-UI recorder and player (a later lane).
- Phase 2 code: no change to `live.ts` channel types or `live-channel.ts`; `live-audio@1` stays reserved.
- Streaming speech, voice selection, a language list.

## Acceptance criteria

- [ ] Strict in, tolerant out for every new schema; refusal tests for each media type, cap and problem.
- [ ] The reference engine refuses oversize, overlong and wrongly typed clips without reading them into any state, keeps no audio, and creates no chat entry for a transcript.
- [ ] Conformance checks above pass against the in-memory engine and fail against a fake that breaks each rule.
- [ ] `engine-api` and `protocol` coverage thresholds hold; `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- What the engine's harnesses can do for speech-to-text and text-to-speech (Codex with a ChatGPT login, Claude Code, an API key) is open for the engine team; runtime unavailability is 503 `voice-unavailable`, not a missing capability.
- A real engine must decode a clip to measure its duration: browsers' WebM from `MediaRecorder` carries no duration header.
