# R-03. Tunnel endpoint: WSS, challenge-response, sessions

- **Lane:** Relay · **Module:** `apps/relay` · **Milestone:** M1
- **Depends on:** R-02, C-02
- **Status:** todo
- **Spec:** Relay and tunnel; Interfaces (draft) 2 and 3; Metadata we still see; Abuse on our domains (takedown); ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md), [0005](../../adr/0005-modular-architecture.md)

## Goal

Engines can open `wss://<RELAY_HOSTNAME>/v1/tunnel`, prove their identity with the challenge-response handshake, and hold an authenticated, multiplexed session that R-04 can open streams on.

## Context

This is the only place the relay terminates TLS, and only for its own hostname. The handshake schemas and the frame codec come from `@ptbk/protocol` (C-02); the relay uses them and never re-implements framing. The relay learns an engine's routable hostnames here: it looks up the engine ID in the registry at auth time, so custom hostnames need no reverse index. R-04 later puts an SNI dispatcher in front of this TLS server on the shared port 443; until then it listens on its own.

## Scope

- `src/domain/tunnel/handshake.ts`: pure steps. `createChallenge(random, relayId)` (`relayId` = the relay's own hostname, C-02) returns the challenge message and nonce; `verifyAuth({ auth, nonce, relayId, registry, engineDomain, signal })` returns `HandshakeOutcome = { kind: 'accepted'; engineId; hostnames; protocolVersion; features } | { kind: 'rejected'; reason: 'unknown-engine' | 'suspended' | 'bad-signature' | 'id-key-mismatch' | 'registry-unavailable' | 'unsupported-version' | 'malformed' }`. It picks the protocol version from the list of supported versions the engine advertises (C-02, ADR 0010: the highest version both sides support) and keeps the engine's advertised feature flags on the session, so additive fields are only sent when the engine announced them. It checks that the engine ID derives from the registry's public key (C-01), verifies the signature over `"ptbk-tunnel-v1" | relayId | nonce`, and takes hostnames from R-02's `routableHostnames` (C-03's `resolveRoutableHostnames`).
- `src/domain/tunnel/reject-mapping.ts`: pure `toWireRejection(outcome)` mapping internal outcomes onto C-02's vocabulary, so the engine learns nothing finer: `unknown-engine`, `bad-signature`, `id-key-mismatch` and `registry-unavailable` → `TunnelReject.reason` `auth-failed` and close code `TUNNEL_CLOSE_CODE['auth-failed']`; `suspended` → `suspended` / `TUNNEL_CLOSE_CODE.suspended`; no common version → `unsupported-version` / `TUNNEL_CLOSE_CODE['protocol-error']`; handshake timeout → `timeout`; pending-handshake limits → `rate-limited`; `malformed` (schema failure, wrong frame type) → no reject message, close with `TUNNEL_CLOSE_CODE['protocol-error']`. The internal reason is logged on the relay only.
- `src/domain/tunnel/tunnel-session.ts`: one authenticated tunnel. Depends on a `TunnelTransport` port (`send(frame: Uint8Array): boolean`, `close(code, reason)`, `bufferedBytes()`). Allocates stream IDs (start at 1, increment, never reuse; close the session on u32 exhaustion), tracks per-stream send and receive credit from `WINDOW` frames, exposes `openStream(clientIp): TunnelStream` and dispatches incoming `DATA`, `CLOSE`, `WINDOW`. Unknown stream IDs and protocol violations (data beyond credit, `OPEN` from the engine) close the session.
- `src/domain/tunnel/session-table.ts`: `SessionTable` with `register(session)`, `byEngine(engineId)`, `byHostname(hostname)`, `remove(session)`. A second tunnel for the same engine on this relay replaces the first (the old one may be half-dead behind NAT); the old one is closed with `TUNNEL_CLOSE_CODE.replaced` (C-02).
- `src/domain/tunnel/revalidation.ts`: every `RELAY_REGISTRY_TTL_S`, re-look up each connected engine. `suspended` closes the tunnel with `TUNNEL_CLOSE_CODE.suspended`; `not-found` and `unavailable` close it with `TUNNEL_CLOSE_CODE['auth-failed']`; changed hostnames update the session table. Short dashboard outages never reach this code: R-02's cached registry keeps answering from stale entries for up to `RELAY_REGISTRY_MAX_STALE_S` (24 h), and only after that does a lookup come back `unavailable`.
- `src/adapters/own-tls-server.ts`: `node:tls` server with the relay's certificate, then a `node:http` server: `GET /v1/tunnel` upgrades with `ws` 8.x (`noServer: true`, `maxPayload` from C-02's maximum frame size), `GET /healthz` returns `200 ok`, everything else `404`. Exposes `acceptSocket(socket)` so R-04 can hand it connections whose bytes it already peeked.
- `src/adapters/ws-tunnel-transport.ts`: `TunnelTransport` over a `ws` socket; binary messages only; WebSocket ping every 25 s, close if no pong within 10 s.
- Config fields added to R-02's schema: `RELAY_TUNNEL_HANDSHAKE_TIMEOUT_MS` (default 10000), `RELAY_MAX_PENDING_HANDSHAKES` (global, default 1000), `RELAY_MAX_PENDING_HANDSHAKES_PER_IP` (default 10), `RELAY_MAX_TUNNELS_PER_IP` (default 50).
- Graceful shutdown: stop accepting, close tunnels with `TUNNEL_CLOSE_CODE['shutting-down']` so engines reconnect at once to a peer relay, then exit.
- Wire it into `start-relay.ts` on `RELAY_LISTEN_PORT`, temporarily without SNI dispatch.

## Out of scope

- Browser connections and piping (R-04). Fast takedown push from the dashboard (I-05). The HTTP registry adapter (D-04).

## Design notes

- Messages before `ready` are JSON text frames validated with C-02's strict schemas; after `ready`, binary frames only. Anything else closes with `TUNNEL_CLOSE_CODE['protocol-error']`. Close reasons are generic: never tell the engine which check failed beyond C-02's `TunnelReject.reason` values (`reject-mapping.ts` is the only place that decides).
- Handshake timeout counts from TCP accept, not from WebSocket upgrade, so a slow TLS client cannot hold a slot.
- Logs (spec, Metadata we still see): `tunnel.connected` and `tunnel.disconnected` with engine ID, engine IP, relay ID and close code. Do not log the engine version from `auth`, nonces, signatures or hostnames.
- The relay holds only public keys. There is no code path that loads an engine private key or certificate; a test asserts the relay config has no field for one.

## Acceptance criteria

- [ ] `handshake` unit tests with in-memory registry and fake clock: valid auth accepted with the highest common protocol version; an engine advertising only unknown versions gets `unsupported-version`; wrong key, nonce from another challenge, other relay ID, engine ID not matching the key, suspended engine, unknown engine, registry unavailable with no cached entry, and an auth with an unknown field are each rejected with the right internal reason.
- [ ] `reject-mapping` tests: every internal outcome maps to the C-02 reason and close code above; `unknown-engine`, `bad-signature`, `id-key-mismatch` and `registry-unavailable` are indistinguishable on the wire.
- [ ] `tunnel-session` tests over a fake transport: stream IDs increase; `DATA` beyond granted credit closes the session; `WINDOW` releases queued data; `CLOSE` for an unknown stream is a protocol error; `OPEN` from the engine side is a protocol error.
- [ ] `session-table` tests: replace semantics, hostname lookup after hostnames change, removal clears every hostname.
- [ ] Integration test (real sockets, port 0, dev certificate generated in the test): a minimal engine client built from `@ptbk/protocol` connects, authenticates, receives `ready` with its default hostname and a valid custom hostname but not an invalid one.
- [ ] Integration tests: no `auth` within the timeout closes the connection; the 11th pending handshake from one IP is refused; a suspended engine is disconnected with `TUNNEL_CLOSE_CODE.suspended` after the next revalidation (fake clock); a registry outage shorter than 24 h keeps the tunnel, a longer one closes it with `auth-failed`; a missing pong closes the tunnel.
- [ ] `SIGTERM` closes tunnels with `TUNNEL_CLOSE_CODE['shutting-down']`.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Suspension cuts existing tunnels only at the next revalidation (up to 5 minutes). Takedown "within hours" is met; faster cut-off is I-05's call.
- A dashboard outage longer than 24 h disconnects every engine at its next revalidation and refuses new tunnels. That is the price of making suspensions stick; I-04 alerts on `registry.stale` long before.
- How the relay obtains its own certificate in production is I-01's (files on disk here).
