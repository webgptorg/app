# M-12. Mock engine: voice behind a dev flag

- **Lane:** M · **Module:** `apps/mock-engine` · **Milestone:** M5
- **Depends on:** C-17
- **Status:** done (#351)
- **Spec:** Access, transport and zero trust

## Goal

The mock engine can speak the voice contract (C-17) for local development and the later UI lane, without anyone getting it by accident.

## Scope

- `MOCK_VOICE=enabled` advertises `voice-input@1` and `voice-output@1`, backed by the in-memory engine's fake transcriber and TTS. Off by default; refused at startup under `NODE_ENV=production`.
- `Permissions-Policy` sends `microphone=(self)` exactly while `voice-input@1` is advertised, `microphone=()` otherwise, on every in-tunnel response.
- The HTTP layer caps the clip at `MAX_VOICE_CLIP_BYTES` before the body is read, and both routes get their own, tighter rate limit.
- Docs: the mock engine's README and [mock-engine.md](../../engine-integration/mock-engine.md).

## Out of scope

- The UI, the dev stack and e2e scenarios (the UI lane adds them).

## Acceptance criteria

- [ ] Tests cover the flag (off by default, on, refused in production), the header both ways, the byte cap and the rate limit.
- [ ] The engine-api conformance suite passes against the mock engine with and without the flag.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.
