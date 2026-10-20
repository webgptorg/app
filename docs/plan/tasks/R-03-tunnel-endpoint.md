# R-03. Tunnel endpoint: WSS, challenge-response, sessions

- **Lane:** Relay · **Module:** `apps/relay` · **Milestone:** M1
- **Depends on:** R-02, C-02
- **Status:** in progress (feat/r-03-tunnel-endpoint)
- **Spec:** Relay and tunnel; Interfaces (draft) 2 and 3; Metadata we still see; Abuse on our domains (takedown); ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md), [0005](../../adr/0005-modular-architecture.md), [0014](../../adr/0014-cryptography.md)

## Goal

Engines can open `wss://<RELAY_HOSTNAME>/v1/tunnel`, prove their identity with the challenge-response handshake, and hold an authenticated, multiplexed session that R-04 can open streams on.

## Context

This is the only place the relay terminates TLS, and only for its own hostname. The handshake schemas and the frame codec come from `@ptbk/protocol` (C-02); the relay uses them and never re-implements framing. The relay learns an engine's routable hostnames here: it looks up the engine ID in the registry at auth time, so custom hostnames need no reverse index. R-04 later puts an SNI dispatcher in front of this TLS server on the shared port 443; until then it listens on its own.

## Scope

- `src/domain/tunnel/handshake.ts`: pure steps. `createChallenge(random, relayId, { versions, features })` (`relayId` = the relay's own hostname, C-02; nonce from the `Random` port) returns the challenge message, carrying the relay's `protocolVersions` and `features`, and the nonce; `verifyAuth({ auth, challenge, registry, engineDomain, signal })` returns `HandshakeOutcome = { kind: 'accepted'; engineId; hostnames; protocolVersion; features } | { kind: 'rejected'; reason: 'unknown-engine' | 'suspended' | 'bad-signature' | 'id-key-mismatch' | 'registry-unavailable' | 'unsupported-version' | 'malformed' }`. It picks the protocol version with C-02's `negotiateTunnel` (ADR 0010: the highest version both sides support; features exactly the intersection) and keeps the result on the session, so additive fields are only sent when both sides announced them. It checks that the engine ID derives from the registry's public key (C-01), verifies the signed negotiation with C-02's `verifyTunnelAuth` over `signingInput('ptbk-tunnel-v1', relayId, nonce, engineId, version, relayVersions, relayFeatures, engineVersions, engineFeatures)` (ADR 0014; `version` is `TunnelAuth.version`, the engine software version, so nothing in `auth` is unsigned), with the relay's lists taken from the challenge it sent, never from the auth message, and strict Ed25519 verification from `@ptbk/protocol` (noble, `zip215: false`), and takes hostnames from R-02's `routableHostnames` (C-03's `resolveRoutableHostnames` plus the CNAME check through the cached `DnsResolver`), so only custom hostnames whose claim verifies and whose CNAME equals `expectedCnameTarget(engineId, engineDomain)` are ever routable.
- `src/domain/tunnel/reject-mapping.ts`: pure `toWireRejection(outcome)` mapping internal outcomes onto C-02's vocabulary, so the engine learns nothing finer: `unknown-engine`, `bad-signature`, `id-key-mismatch` and `registry-unavailable` → `TunnelReject.reason` `auth-failed` and close code `TUNNEL_CLOSE_CODE.AUTH_FAILED`; `suspended` → `suspended` / `TUNNEL_CLOSE_CODE.SUSPENDED`; no common version → `unsupported-version` / `TUNNEL_CLOSE_CODE.PROTOCOL_ERROR`; handshake timeout → `timeout` / `TUNNEL_CLOSE_CODE.PROTOCOL_ERROR`; pending-handshake limits → `rate-limited`, then close code 1013 (Try Again Later; the only reject outside 4000–4999); `malformed` (schema failure, wrong frame type) → no reject message, close with `TUNNEL_CLOSE_CODE.PROTOCOL_ERROR`. Use C-02's `TUNNEL_CLOSE_CODE` names exactly; no numeric literals except 1013. The internal reason is logged on the relay only.
- `src/domain/tunnel/tunnel-session.ts`: one authenticated tunnel. Depends on a `TunnelTransport` port (`send(frame: Uint8Array): boolean`, `close(code, reason)`, `bufferedBytes()`). Allocates stream IDs (start at 1, increment, never reuse; close the session on u32 exhaustion), tracks per-stream send and receive credit from `WINDOW` frames, exposes `openStream(clientIp): TunnelStream` and dispatches incoming `DATA`, `CLOSE`, `WINDOW`. Unknown stream IDs and protocol violations (data beyond credit, `OPEN` from the engine) close the session.
- `src/domain/tunnel/session-table.ts`: `SessionTable` with `register(session)`, `byEngine(engineId)`, `byHostname(hostname)`, `remove(session)`. A second tunnel for the same engine on this relay replaces the first (the old one may be half-dead behind NAT); the old one is closed with `TUNNEL_CLOSE_CODE.REPLACED` (C-02). If two connected engines both have a hostname in their routable set, `byHostname` returns nothing for it (route neither) and logs `hostname.conflict` with both engine IDs, never the hostname; the hostname becomes routable again once only one engine claims it (after a disconnect or a revalidation).
- `src/domain/tunnel/revalidation.ts`: every `RELAY_REGISTRY_TTL_S`, re-look up each connected engine. `suspended` closes the tunnel with `TUNNEL_CLOSE_CODE.SUSPENDED`; `not-found` and `unavailable` close it with `TUNNEL_CLOSE_CODE.AUTH_FAILED`; hostnames are recomputed with `routableHostnames` (claims and the cached CNAME check), and changes update the session table. Short dashboard outages never reach this code: R-02's cached registry keeps answering from stale entries for up to `RELAY_REGISTRY_MAX_STALE_S` (24 h), and only after that does a lookup come back `unavailable`.
- `src/adapters/own-tls-server.ts`: `node:tls` server with the relay's certificate and explicit settings (ADR 0014): `minVersion: 'TLSv1.2'` (raised to 1.3 once X-02 shows TLS-inspecting proxies cope), TLS 1.2 `ciphers` limited to ECDHE with AES-GCM or ChaCha20-Poly1305; then a `node:http` server: `GET /v1/tunnel` upgrades with `ws` (`"ws": "catalog:"`, pinned to `8.22.0` in the root workspace catalog; `noServer: true`, `maxPayload` from C-02's maximum frame size), `GET /healthz` returns `200 ok`, everything else `404`. Exposes `acceptSocket(socket)` so R-04 can hand it connections whose bytes it already peeked.
- `src/adapters/ws-tunnel-transport.ts`: `TunnelTransport` over a `ws` socket; binary messages only; WebSocket ping every 25 s, close if no pong within 10 s.
- Config fields added to R-02's schema: `RELAY_TUNNEL_HANDSHAKE_TIMEOUT_MS` (default 10000), `RELAY_MAX_PENDING_HANDSHAKES` (global, default 1000), `RELAY_MAX_PENDING_HANDSHAKES_PER_IP` (default 10), `RELAY_MAX_TUNNELS_PER_IP` (default 50).
- Graceful shutdown: stop accepting, close tunnels with `TUNNEL_CLOSE_CODE.SHUTTING_DOWN` so engines reconnect at once to a peer relay, then exit.
- Wire it into `start-relay.ts` on `RELAY_LISTEN_PORT`, temporarily without SNI dispatch.

## Out of scope

- Browser connections and piping (R-04). Fast takedown push from the dashboard (I-05). The HTTP registry adapter (D-04).

## Design notes

- Messages before `ready` are JSON text frames validated with C-02's strict schemas; after `ready`, binary frames only. Anything else closes with `TUNNEL_CLOSE_CODE.PROTOCOL_ERROR`. Close reasons are generic: never tell the engine which check failed beyond C-02's `TunnelReject.reason` values (`reject-mapping.ts` is the only place that decides).
- Handshake timeout counts from TCP accept, not from WebSocket upgrade, so a slow TLS client cannot hold a slot.
- Logs (spec, Metadata we still see): `tunnel.connected` and `tunnel.disconnected` with engine ID, engine IP, relay ID and close code. Do not log the engine version from `auth`, nonces, signatures or hostnames.
- The relay holds only public keys. There is no code path that loads an engine private key or certificate; a test asserts the relay config has no field for one.

## Acceptance criteria

- [ ] `handshake` unit tests with in-memory registry and fake clock: valid auth accepted with the highest common protocol version and the exact feature intersection; an auth signed over a stripped or altered relay or engine version or feature list, or with `version` (engine software version) changed after signing, is rejected as `bad-signature`; an engine advertising only unknown versions gets `unsupported-version`; wrong key, nonce from another challenge, other relay ID, engine ID not matching the key, suspended engine, unknown engine, registry unavailable with no cached entry, and an auth with an unknown field are each rejected with the right internal reason.
- [ ] `reject-mapping` tests: every internal outcome maps to the C-02 reason and close code above (`rate-limited` sends `reject` then closes with 1013); `unknown-engine`, `bad-signature`, `id-key-mismatch` and `registry-unavailable` are indistinguishable on the wire.
- [ ] `tunnel-session` tests over a fake transport: stream IDs increase; `DATA` beyond granted credit closes the session; `WINDOW` releases queued data; `CLOSE` for an unknown stream is a protocol error; `OPEN` from the engine side is a protocol error.
- [ ] `session-table` tests: replace semantics, hostname lookup after hostnames change, removal clears every hostname; two engines with the same custom hostname route neither and log `hostname.conflict`, and the survivor routes it after the other disconnects.
- [ ] TLS test: a TLS 1.1 client and a TLS 1.2 client offering only CBC or non-ECDHE suites fail the handshake; TLS 1.3 and TLS 1.2 ECDHE-AES-GCM succeed.
- [ ] Integration test (real sockets, port 0, dev certificate generated in the test): a minimal engine client built from `@ptbk/protocol` connects, authenticates, receives `ready` with its default hostname and a valid custom hostname (claim valid, CNAME in the fake `DnsResolver` pointing at its default hostname) but not one with an invalid claim or a wrong CNAME.
- [ ] Integration tests: no `auth` within the timeout closes the connection; the 11th pending handshake from one IP is refused; a suspended engine is disconnected with `TUNNEL_CLOSE_CODE.SUSPENDED` after the next revalidation (fake clock); a registry outage shorter than 24 h keeps the tunnel, a longer one closes it with `TUNNEL_CLOSE_CODE.AUTH_FAILED`; a missing pong closes the tunnel.
- [ ] `SIGTERM` closes tunnels with `TUNNEL_CLOSE_CODE.SHUTTING_DOWN`.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Suspension cuts existing tunnels only at the next revalidation (up to 5 minutes). Takedown "within hours" is met; faster cut-off is I-05's call.
- A dashboard outage longer than 24 h disconnects every engine at its next revalidation and refuses new tunnels. That is the price of making suspensions stick; I-04 alerts on `registry.stale` long before.
- How the relay obtains its own certificate in production is I-01's (files on disk here).
