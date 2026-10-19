# @ptbk/protocol

Wire contracts between the engine, the relay and the dashboard (spec, Interfaces 1 to 5): engine IDs and hostname claims, engine registration, registry lookup, tunnel handshake and frame codec, heartbeat, and the release log with its verification. zod schemas, strict and versioned.

MIT, Web APIs only (`crypto.subtle`, streams), no imports from `@ptbk/*`, so it runs in Node, Workers and browsers and can move to the public repo unchanged ([ADR 0002](../../docs/adr/0002-public-private-split.md)). Plan: tasks C-01, C-02, C-03, C-06.
