# Voice: push-to-talk and spoken replies

Phase 1 of issue #332: a member speaks to an agent and hears it answer. Two capabilities, each on its own, so an engine can offer one without the other:

- `voice-input@1`: push-to-talk. The browser records a short clip and uploads it; the engine transcribes it into a **draft** for the composer.
- `voice-output@1`: spoken replies. The engine reads one chat message aloud in a format the browser can play.

Contract: [voice.ts](../../packages/engine-api/src/capabilities/voice.ts). Reference behaviour: the in-memory engine's [voice.ts](../../packages/engine-api/src/in-memory/voice.ts) with its tests. Implementation brief for the engine: the [AGENT_BRIEF entry "Voice phase 1" of 2026-11-20](AGENT_BRIEF.md). Full-duplex conversation is phase 2, designed only: [live-sessions.md, Live audio](live-sessions.md#live-audio-phase-2).

**Not rolled out.** No real engine advertises either capability yet, the in-memory engine leaves them out of `DEFAULT_CAPABILITIES`, and the mock engine advertises them only with `MOCK_VOICE=enabled` (M-12). The engine UI's recorder and player come in a later lane.

## The boundary

**Decided.** Both are ordinary engine API requests: `POST`s on the engine origin, inside the browser's TLS connection to the engine, through the relay like every other call. No new transport, tunnel frame or relay change; relays see ciphertext and the dashboard sees nothing. Speech-to-text and text-to-speech run on the engine or its harness's provider, never through our services. [ADR 0019](../adr/0019-live-sessions-inside-the-tunnel.md)'s boundary and its `Permissions-Policy` rule cover this; phase 1 only moves the microphone rule from `live-audio@1` to whichever voice capability comes first.

## Push-to-talk (`voice-input@1`)

`POST /chats/{chatId}/transcriptions` (`transcribeVoiceClip`), permission `chats.write`: the member could type into this chat, so they may speak into it. The chat must exist and be visible to the member (404 otherwise).

- **Body:** the clip itself, raw, not multipart. Its `Content-Type` must be one of `VOICE_CLIP_FORMATS`, compared after `normalizeMediaType` (lowercase, no whitespace, parameter values unquoted, so Firefox's `audio/ogg; codecs="opus"` is `audio/ogg;codecs=opus`):

  | Format                   | Who sends it                                                                            |
  | ------------------------ | --------------------------------------------------------------------------------------- |
  | `audio/webm;codecs=opus` | `MediaRecorder` in Chromium browsers                                                    |
  | `audio/ogg;codecs=opus`  | `MediaRecorder` in Firefox                                                              |
  | `audio/wav`              | The fallback any browser can make without a codec (Safari): 16-bit PCM, mono, 16,000 Hz |

  All three go to common speech-to-text providers unchanged, so the engine usually need not transcode. Anything else, or no `Content-Type`, is 415 `unsupported-media-type`.

- **Query:** optional `language`, a BCP 47 tag (`en`, `cs-CZ`) the UI passes when it knows what the member speaks; without it the engine or provider detects the language.
- **Size:** at most `MAX_VOICE_CLIP_BYTES` (2 MiB), refused with 413 `payload-too-large` from `Content-Length` or while reading, before anything looks at the audio. 60 seconds of the WAV fallback is 1,920,044 bytes, so 2 MiB holds the longest clip in the largest format; Opus at the UI's 32 kbit/s needs about 240 KB.
- **Length:** at most `MAX_VOICE_CLIP_MS` (60 s); longer is 422 `voice-clip-too-long`. Push-to-talk is for one message, not dictation. Measure it by decoding: `MediaRecorder`'s WebM states no duration, so a header is not enough.
- **Answer:** 200 `TranscriptDraft`:
  - `text`: what was said, at most `MAX_TRANSCRIPT_LENGTH` (4,000) characters; empty when no speech was heard;
  - `language`: detected or as asked, `null` when the provider does not say;
  - `confidence`: the provider's overall confidence from 0 to 1, `null` when it reports none;
  - `durationMs`: the clip's length as the engine decoded it.

### A draft never sends itself

**Decided.** The transcript is a suggestion. The UI puts `text` into the composer, the member reads and edits it, and only sending it creates a message, through the ordinary `POST /chats/{chatId}/messages`. Transcribing adds no chat entry, emits no `chat.changed` and wakes no agent. The UI never sends on its own.

### Nothing kept

**Decided.**

- The engine keeps no audio after the request: not on disk, not in a cache, not in the chat, not attached to the message the member later sends. Hand the provider the bytes and drop them.
- Neither the audio nor the transcript goes into a log, an error, a problem's `detail` or the audit log. Log at most the outcome, the duration and the format.
- The transcript is model output: the UI renders it as text only, like every message.

## Spoken replies (`voice-output@1`)

`POST /chats/{chatId}/messages/{messageId}/speech` (`speakChatMessage`), permission `chats.read`: anyone who may read the message may hear it. A chat or message the member cannot see, or a message that is not in that chat, is 404.

- **Body:** `{ formats }`, the formats the browser can play, from `SPEECH_FORMATS`, in its order of preference, each once:

  | Format                  | Why                                                       |
  | ----------------------- | --------------------------------------------------------- |
  | `audio/mpeg`            | Every browser decodes MP3; what most TTS providers return |
  | `audio/ogg;codecs=opus` | The smallest, where the browser decodes it                |
  | `audio/wav`             | No codec at all                                           |

- **Answer:** 200 with the audio as the body, its `Content-Type` the **first** offered format the engine can make, sent as an attachment with `X-Content-Type-Options: nosniff` and `Cache-Control: no-store`. None of them is 415 `unsupported-media-type`.
- **What is spoken:** the message's `content`, which must be `completed` and non-empty (409 `message-not-speakable` while it streams, after it failed or was cancelled, or when empty). At most `MAX_SPEECH_TEXT_LENGTH` (4,000) UTF-16 code units of `content` as the API sends it, so the UI knows before asking; longer is 422 `speech-too-long`. The engine may drop Markdown syntax before speaking.
- **No caching.** The audio is made for this request and neither stored nor cached by the engine; our services never see it anyway.
- **Playing it.** The UI decodes the answer with Web Audio (`AudioContext.decodeAudioData`) and plays the buffer, never through a `blob:` URL, so `ENGINE_UI_CSP` needs no `media-src` and does not change.

## Problems

Closed codes, each with its fixed status ([problem-codes.ts](../../packages/engine-api/src/problem-codes.ts)):

| Code                     | Status | When                                                                                     |
| ------------------------ | ------ | ---------------------------------------------------------------------------------------- |
| `unsupported-media-type` | 415    | A clip in no listed format; speech in none of the offered formats                        |
| `payload-too-large`      | 413    | A clip over `MAX_VOICE_CLIP_BYTES`                                                       |
| `voice-clip-too-long`    | 422    | A decoded clip over `MAX_VOICE_CLIP_MS`                                                  |
| `transcription-failed`   | 502    | The engine or provider could not transcribe this clip, unreadable audio included         |
| `speech-too-long`        | 422    | The message's text is over `MAX_SPEECH_TEXT_LENGTH`                                      |
| `message-not-speakable`  | 409    | The message is streaming, failed, cancelled or empty                                     |
| `speech-failed`          | 502    | The engine or provider could not make the audio                                          |
| `voice-unavailable`      | 503    | The capability is advertised, but no speech provider is ready now (a harness signed out) |

`voice-unavailable` is runtime, not a missing capability: advertise `voice-input@1` or `voice-output@1` when the engine can do it in principle (a harness or key that offers it is configured), and answer 503 when that provider cannot serve this request. An engine without any such provider does not advertise the capability, and its routes answer 404 `capability-not-supported`. Problems never quote the provider's message or the audio.

## Rate limits

**Recommended.** Each request is a paid provider call: limit both routes per member, tighter than the rest of the API, and answer 429 `rate-limited` with `Retry-After`. We suggest 20 transcriptions and 30 speech requests per member per minute, plus a budget per engine. The mock engine gives them their own per-IP rule (M-12).

## Microphone permission

**Decided.** The engine's `Permissions-Policy` sends `microphone=(self)` exactly while `GET /engine` advertises `voice-input@1`, and `microphone=()` otherwise; never `*` or another origin ([gateway.md](gateway.md#security-headers)). The browser still asks the member the first time. `voice-output@1` needs no permission. `ENGINE_UI_CSP` does not change.

## Reference behaviour

The in-memory engine implements both with a deterministic fake provider and no dependency:

- **Transcriber:** a WAV's length comes from its header; for WebM and Ogg it checks the container's magic bytes and estimates the length at 32 kbit/s (a real engine decodes). A silent WAV gives empty `text`; any other clip gives one of `FAKE_TRANSCRIPTS`, picked by the clip's SHA-256, with `confidence` 0.92 and `language` as asked or `en`.
- **TTS:** answers only in `audio/wav`, a short sine tone as long as the text would roughly take (at most 3 s), so a browser that offers only MP3 gets 415.
- **Levers** on the controller: `failVoice('transcription-failed' | 'speech-failed' | 'voice-unavailable' | null)` breaks the provider until healed; `setVoiceTranscript(clipSha256, text)` decides what the fake hears in one clip.

## Conformance

Each check skips with `capability-not-advertised` when its capability is not advertised, except the last, which runs on every engine behind a gateway.

| Check                                  | Asserts                                                                                                                                                                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine-api.voice.transcription-caps`  | 415 for `audio/mpeg`, `text/plain` and no `Content-Type`; 413 for `MAX_VOICE_CLIP_BYTES` + 1 bytes; 422 `voice-clip-too-long` for a 61 s silent WAV; 404 for an unknown chat; none of them adds a chat entry                          |
| `engine-api.voice.transcription-draft` | A 1 s WAV gives a draft with `durationMs` within 250 ms and no new chat entry; a marker in its samples appears in no answer and not in the audit log; skips on 503 `voice-unavailable`                                                |
| `engine-api.voice.speech`              | Each format alone is 200 in exactly that format or 415, at least one is 200; all formats in order give the first that works; an unknown message is 404; a message of `MAX_SPEECH_TEXT_LENGTH` + 1 characters is 422 `speech-too-long` |
| `engine-api.voice.permissions`         | 403 without `chats.write` (transcribe) or `chats.read` (speak)                                                                                                                                                                        |
| `engine-api.voice.permissions-policy`  | `Permissions-Policy` on an API answer and on an anonymous page: `microphone=()` without `voice-input@1`, `microphone=(self)` with it, never `*` or an origin                                                                          |

## Open for the engine team

1. What the harnesses can do for speech-to-text and text-to-speech: Codex with a ChatGPT login, Claude Code, an OpenAI or other provider API key, a local model (Whisper, Piper). Which of them the engine would advertise voice for.
2. Which formats they take and return, and whether the engine must transcode (WebM to Ogg, PCM to MP3). The lists only grow within a version; `audio/mp4` (Safari's `MediaRecorder`) can be added if a provider takes it.
3. Languages: whether the provider detects them, and whether `language` should be a list the engine reports.
4. Cost and limits: the per-member and per-engine rate limits that fit the provider's pricing, and whether owners should be able to turn voice off.
5. Streaming speech (start playing before the whole reply is synthesised) and voice selection are later, additive changes.
