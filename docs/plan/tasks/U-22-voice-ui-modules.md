# U-22. Voice building blocks: push-to-talk and read aloud

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M5
- **Depends on:** C-17, M-12
- **Status:** done (#364)
- **Spec:** Access, transport and zero trust; ADRs: [0015](../../adr/0015-ui-architecture-and-design-system.md), [0016](../../adr/0016-engine-capabilities.md)
- **Design:** [ui.md](../../design/ui.md), [voice.md](../../engine-integration/voice.md)

## Goal

The engine UI side of issue #332, phase 1, prepared but not mounted: a self-contained voice feature module that a later change mounts in the composer and the message row in a few lines.

## Context

Decision (Seb, 2026-11-23): "just prepare these, don't put them inside the UI yet, keep the architecture clean and modular so it's actually usable in the future." The product UI looks and behaves exactly as before. `ENGINE_UI_CSP` and the header policies do not change.

## Scope

- `features/voice/`: capability hooks (engine advertises it and the browser supports it), a `MediaRecorder` recorder that picks a format from `VOICE_CLIP_FORMATS`, enforces `MAX_VOICE_CLIP_MS` and `MAX_VOICE_CLIP_BYTES` and always releases the microphone, typed calls to `transcribe` and `speak`, plain copy for every voice problem code, a speech player that negotiates `SPEECH_FORMATS` with `canPlayType` and plays through `AudioContext.decodeAudioData`, with no object URLs, and presentational push-to-talk and read-aloud buttons.
- Gallery entries for both buttons' states.
- en and cs copy.

## Out of scope

- Mounting anything in the composer, message rows, routes or navigation.
- The CSP, `Permissions-Policy` and the e2e scenarios.

## Acceptance criteria

- [x] Tests with fakes for `MediaRecorder`, `getUserMedia` and Web Audio: permission denied, unsupported format, cap reached, every problem code, unmount mid-recording releases the microphone, the audio output closed.
- [x] Nothing renders in the product; no CSP or header change; `test:csp` passes.
- [x] Audio and transcripts are never logged or put into errors.
- [x] **Status** line above set to `done (#<PR>)`.
