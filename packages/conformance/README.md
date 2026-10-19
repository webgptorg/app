# @ptbk/conformance

One test suite that any engine implementation must pass to replace the mock engine: engine API behaviour, tunnel handshake and framing, heartbeat, registration and UI loader checks. It runs against the mock engine in CI and against the real engine once it exists, and the engine team can run it on its own.

MIT, moves to the public repo with the other contracts ([ADR 0002](../../docs/adr/0002-public-private-split.md)). Plan: task C-05.

`conformance` imports only `@ptbk/protocol` and `@ptbk/engine-api`.
