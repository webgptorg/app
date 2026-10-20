# M-01. Mock engine skeleton and tunnel client (N relays, proxy, reconnect)

- **Lane:** Mock engine · **Module:** `apps/mock-engine` · **Milestone:** M1
- **Depends on:** C-02
- **Status:** done (#15)
- **Spec:** Relay and tunnel; Interfaces (draft) 3 and 6; Pairing and identity (Identities); Operations; ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md), [0005](../../adr/0005-modular-architecture.md), [0014](../../adr/0014-cryptography.md)

## Goal

`apps/mock-engine` becomes a Node 24 process with a persistent Ed25519 identity that holds an authenticated tunnel to every relay in its list, through an HTTP CONNECT proxy when configured, reconnects on its own, and turns each tunnel stream into a Node `Duplex` with correct flow control.

## Context

The mock engine is the reference implementation of the engine side of the tunnel protocol (ADR 0004): the engine team will read this code. It uses `@ptbk/protocol` (C-01, C-02) for identity helpers, handshake schemas and the frame codec, and never re-implements them. M-02 plugs a TLS server into the streams this task produces; M-06 later replaces the configured relay list with the one from registration.

## Scope

- `src/app/config.ts`: `parseMockEngineConfig(env)`, strict zod, frozen. Spec variables: `PTBK_MODE` (`tunnel` only for now), `PTBK_DATA_DIR`, `HTTPS_PROXY`/`https_proxy`, `NO_PROXY`/`no_proxy`. Mock variables: `PTBK_RELAYS` (comma-separated `wss://` URLs; M-06 makes it a dev override), `PTBK_ENGINE_DOMAIN`, `PTBK_ENGINE_VERSION` (default from `package.json`), `MOCK_EXTRA_CA_FILE` (optional PEM added to Node's default roots, for the dev relay CA or a TLS-inspecting proxy), `LOG_LEVEL`.
- `src/domain/identity/engine-identity.ts`: `EngineIdentity { engineId; publicKey; sign(bytes): Promise<Uint8Array> }`; engine ID and signing via C-01 helpers (WebCrypto). The key is generated extractable only so it can be written once; at runtime it is imported non-extractable. Port `IdentityStore { loadOrCreate(): Promise<EngineIdentity> }`.
- `src/adapters/fs-identity-store.ts`: creates `PTBK_DATA_DIR` with mode 0700 if missing, stores the key as PKCS#8 PEM in `engine-key.pem` with mode 0600, and refuses to start if the directory or file is group- or world-accessible (like OpenSSH).
- `Random` port from C-01 (`crypto.getRandomValues`) for jitter and anything else random; tests inject the seeded fake, which config never wires.
- `src/domain/tunnel/backoff.ts`: `nextDelayMs(attempt, random)` with full jitter, base 500 ms, factor 2, cap 10 s; reset after 60 s of a healthy tunnel. A close with `TUNNEL_CLOSE_CODE.SHUTTING_DOWN` (C-02; use its names exactly, never numeric literals) retries after a 0–500 ms jitter; `TUNNEL_CLOSE_CODE.AUTH_FAILED`, `TUNNEL_CLOSE_CODE.SUSPENDED`, close code 1013 (Try Again Later, sent after a `rate-limited` reject) and any `TunnelReject` back off normally and log the C-02 reason.
- `src/domain/tunnel/relay-link.ts`: the state machine for one relay (`idle → connecting → handshaking → ready → backoff`), driven by a `RelayDialer` port and a `Clock`. Advertises the protocol versions and feature flags it supports in the handshake (C-02, ADR 0010) and records the version the relay picked. Before signing, checks that the challenge's `relayId` equals the relay hostname it dialled (from the relay URL), and closes without signing otherwise, so a signature can never be replayed to another relay. Builds `auth` with C-02's `signTunnelAuth`, which signs the negotiation (ADR 0014): `signingInput('ptbk-tunnel-v1', relayId, nonce, engineId, version, relayVersions, relayFeatures, engineVersions, engineFeatures)`, where `version` is `TunnelAuth.version` (`PTBK_ENGINE_VERSION`), so nothing in `auth` is unsigned, and the relay's lists are taken from the challenge. Validates every incoming message. On `ready`, recomputes the result from both signed lists and closes with `TUNNEL_CLOSE_CODE.PROTOCOL_ERROR` unless `protocolVersion` is the highest common version and `features` exactly the intersection (downgrade protection); then records the hostnames the relay accepted (logs a warning if the engine's default hostname is missing).
- `src/domain/tunnel/stream-mux.ts`: pure per-tunnel stream state: `OPEN` from the relay creates a stream with the client IP; tracks send credit (from the relay's `WINDOW`) and receive credit (granted by us); rejects `DATA` beyond the credit we granted, duplicate `OPEN` and unknown stream IDs as protocol errors that close the tunnel.
- `src/adapters/tunnel-duplex.ts`: a `Duplex` per stream. `_write` splits into `DATA` frames no larger than C-02's maximum payload and waits for send credit; incoming `DATA` is `push`ed and `WINDOW` credit is granted back only as the consumer reads (`_read`). `CLOSE` ends and destroys the duplex; destroying the duplex sends `CLOSE`. Exposes `remoteAddress` from `OPEN`.
- `src/adapters/ws-relay-dialer.ts`: `ws` client (`"ws": "catalog:"`, pinned to `8.22.0` in the root workspace catalog) that verifies the relay certificate (`rejectUnauthorized: true`, `servername` = relay hostname, also through the proxy), binary frames, WebSocket ping every 25 s, close if no pong within 10 s, connect and handshake timeouts.
- `src/adapters/http-connect-proxy.ts`: when `HTTPS_PROXY` applies (honouring `NO_PROXY` host and suffix rules), open the TCP connection with an HTTP `CONNECT` request (optional basic auth from the proxy URL), then TLS to the relay over that socket and hand it to `ws` via `createConnection`. Non-2xx answers fail the attempt with the status code only.
- `src/app/start-mock-engine.ts` and `src/main.ts`: compose and start one `relay-link` per relay; expose an `onStream(handler)` hook for M-02. `SIGTERM` closes all tunnels cleanly.
- CLI: `bun run --filter @ptbk/mock-engine identity` prints `{ engineId, enginePublicKey, hostname }` as JSON (creating the identity if missing), so X-01 can write the relay's static registry file.
- Scripts `dev` (tsx 4.x), `build` (same bundler as R-02), `start`.

## Out of scope

- TLS and HTTP inside the streams (M-02). Registration and heartbeat (M-06). Throttling the tunnel for fault injection (M-04).

## Design notes

- Tunnels to different relays are independent: one relay failing never delays the others, and a stream lives on exactly one tunnel.
- Logs: relay URL, state changes, close codes, attempt numbers. Never the private key, signatures, proxy credentials or stream bytes.
- Keep the Node-specific parts in adapters; `relay-link` and `stream-mux` are tested with fakes only.

## Acceptance criteria

- [ ] Identity tests (temp dir): first start creates 0700 dir and 0600 key; second start loads the same engine ID; a 0644 key file or 0755 dir makes startup fail with a clear message.
- [ ] `backoff` tests with the seeded `Random` fake: delays within bounds, cap respected, reset after a healthy period, fast retry on `TUNNEL_CLOSE_CODE.SHUTTING_DOWN`, normal backoff on 1013.
- [ ] `relay-link` tests with a fake dialer and fake clock: handshake success with the advertised versions and features sent and the picked version recorded; the sent `auth` passes C-02's `verifyTunnelAuth` and fails it when any version or feature list (relay's or engine's) is stripped or altered or the engine `version` is changed; a `ready` with a lower-than-highest common version or a feature set other than the intersection closes with `TUNNEL_CLOSE_CODE.PROTOCOL_ERROR`; a challenge whose `relayId` differs from the dialled hostname closes without sending `auth`, a challenge with an unknown field closes and backs off, a timeout during handshake backs off, a lost tunnel reconnects.
- [ ] `stream-mux` and `tunnel-duplex` tests: a 5 MB transfer each way through a fake transport arrives intact; a slow consumer stops `WINDOW` grants so buffered bytes stay within the window; `DATA` beyond granted credit closes the tunnel.
- [ ] Integration test against the real relay (R-03, in process, port 0) when available, otherwise against a minimal in-test relay built from `@ptbk/protocol`: two relays, both tunnels reach `ready`; killing one leaves the other `ready`; restarting it reconnects within 10 s.
- [ ] Proxy test with a minimal in-test CONNECT proxy: the tunnel connects through it; a relay certificate for another hostname or from an untrusted CA fails the attempt; `NO_PROXY` bypasses it; a 407 answer is retried with backoff and logged without credentials.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- If C-02 defines half-close for `CLOSE`, implement it in `tunnel-duplex`; otherwise `CLOSE` is a full close and TLS `close_notify` covers orderly shutdown.
- TLS-inspecting proxies (spike criterion) also need `MOCK_EXTRA_CA_FILE` for the relay connection. X-02 tests it end to end.
