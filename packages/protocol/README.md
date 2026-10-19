# @ptbk/protocol

Wire contracts between the engine, the relay and the dashboard (spec, Interfaces 1 to 5): engine IDs and hostname claims, engine registration, registry lookup, tunnel handshake and frame codec, heartbeat, and the release log with its verification. zod schemas, strict and versioned.

It also holds the TLS ClientHello parser (`parseClientHello`, `createClientHelloBuffer`) that the relay routes on and engines use to spot `acme-tls/1`. It is total over untrusted bytes, bounded by `maxBytes`, and fuzzed with fast-check. Its fixtures in `src/tls/fixtures/` are real ClientHellos captured with `scripts/capture-client-hello.ts`, which documents how each was made.

MIT, Web APIs only (`crypto.subtle`, streams), no imports from `@ptbk/*`, so it runs in Node, Workers and browsers and can move to the public repo unchanged ([ADR 0002](../../docs/adr/0002-public-private-split.md)). Plan: tasks C-01, C-02, C-03, C-06, R-01.
