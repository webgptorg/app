# C-02. Tunnel handshake schemas and binary frame codec

- **Lane:** Contracts · **Module:** `packages/protocol` · **Milestone:** M1
- **Depends on:** C-01 · **Unblocks:** R-03, M-01, E-01
- **Status:** todo
- **Spec:** Interfaces (draft) 3. Tunnel protocol, Relay and tunnel; ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md), [0005](../../adr/0005-modular-architecture.md)

## Goal

`@ptbk/protocol` exports the tunnel handshake messages, the signing helpers for the challenge-response, a binary frame codec and a pure flow-control window, so the relay (R-03, R-04) and the mock engine (M-01) implement both ends from one definition.

## Context

The tunnel is the only path between browsers and engines behind NAT. The relay is public-facing and parses frames from engines it does not trust, so the decoder must never throw, allocate unbounded memory or accept ambiguous input. The spike may replace framing with yamux over WebSocket; keep the codec behind its own module so that swap touches only this file and its two users.

## Scope

- `src/tunnel/constants.ts`: `TUNNEL_PATH = '/v1/tunnel'`, `TUNNEL_SUBPROTOCOL = 'ptbk-tunnel.v1'`, `PING_INTERVAL_MS = 25_000`, `AUTH_TIMEOUT_MS = 10_000`, `INITIAL_WINDOW_BYTES = 262_144`, `MAX_FRAME_PAYLOAD_BYTES = 65_536`, `NONCE_BYTES = 32`.
- `src/tunnel/handshake.ts`: strict zod schemas for the JSON text messages, discriminated on `type`, each with `v: 1`:
  - `TunnelChallenge { v, type: 'challenge', nonce: base64url(32 bytes), relayId: RelayId }`
  - `TunnelAuth { v, type: 'auth', engineId: EngineId, version: EngineVersion, sig: Ed25519Signature }`
  - `TunnelReady { v, type: 'ready', hostnames: Hostname[] (1–32, unique) }`
  - `TunnelReject { v, type: 'reject', reason: 'unknown-engine' | 'suspended' | 'bad-signature' | 'unsupported-version' | 'timeout' | 'rate-limited' }` (proposed, see open points)
  - `parseRelayMessage(text)` / `parseEngineMessage(text)` returning `{ kind: 'ok', message } | { kind: 'invalid' }`.
- `relayId` is the relay's own hostname (e.g. `relay-fsn.<domain>`), branded `RelayId`, so the signature binds to the relay the engine meant to dial; the engine checks that the challenge's `relayId` equals the hostname it connected to before signing.
- `src/tunnel/auth.ts`: `tunnelAuthInput(relayId, nonce)` = `signingInput('ptbk-tunnel-v1', relayId, nonceBase64Url)`; `signTunnelAuth(signer, challenge, version)`; `verifyTunnelAuth(publicKey, challenge, auth)`.
- `src/tunnel/frame.ts`: `FrameType = { OPEN: 1, DATA: 2, CLOSE: 3, WINDOW: 4 } as const`; `Frame` discriminated union; `encodeFrame(frame): Bytes`; `decodeFrame(bytes): { kind: 'frame', frame } | { kind: 'invalid', reason }`; `StreamId` branded (u32, non-zero).
- `src/tunnel/window.ts`: `createSendWindow(initial)` and `createReceiveWindow(initial)`: pure credit accounting (`consume(n)`, `grant(n)`, `available()`), with `{ kind: 'violation' }` when a peer sends beyond credit.

## Out of scope

- WebSocket server and client, sessions, reconnect, proxies (R-03, M-01). SNI parsing (R-01). Registry lookup (C-03, R-02).

## Design notes

- Frame layout per spec: `[u8 type][u32 streamId, big-endian][payload]`, one frame per binary WebSocket message.
- `OPEN` payload: `[u8 family: 4 | 6][4 or 16 address bytes][u16 client port, BE]`; exact length, no trailing bytes. Only the relay opens streams; stream IDs increase per tunnel and are never reused.
- `DATA`: raw bytes, 1..`MAX_FRAME_PAYLOAD_BYTES`. `CLOSE`: `[u8 code]` with `CLOSE_CODE = { NORMAL: 0, RESET: 1, REFUSED: 2, TIMEOUT: 3, FLOW_CONTROL: 4 }`. `WINDOW`: `[u32 credit increment, BE]`, 1..2^31−1.
- Invalid reasons: `too-short`, `unknown-type`, `stream-id-zero`, `payload-too-large`, `empty-data`, `bad-open-payload`, `bad-close-code`, `bad-window-increment`, `trailing-bytes`. The decoder copies no more than one payload and never reads past the buffer.
- Each direction starts with `INITIAL_WINDOW_BYTES` credit per stream; the receiver grants more with `WINDOW` after delivering bytes downstream. Sending past credit is a protocol violation and the stream is closed with `FLOW_CONTROL`.
- Versioning: the WebSocket subprotocol header selects the frame codec; the JSON messages carry `v`. A `v2` lives next to `v1`, never instead of it.

## Acceptance criteria

- [ ] Property tests (fast-check): `decodeFrame(encodeFrame(f))` equals `f` for arbitrary valid frames; `decodeFrame` never throws on arbitrary byte arrays up to 128 KiB; every one-byte truncation of a valid frame is `invalid`.
- [ ] Unit tests for each invalid reason, IPv4 and IPv6 `OPEN`, maximum payload accepted, one byte over rejected, `streamId` 0 and 2^32−1.
- [ ] Handshake: unknown field, missing `v`, `v: 2`, 31- and 33-byte nonces, and an uppercase engine ID are all rejected.
- [ ] `verifyTunnelAuth` passes for a correct signature and fails for a different relay ID, a different nonce, another key, and a hostname-claim signature over the same bytes.
- [ ] Window tests: consume exactly the credit succeeds, one byte more is a violation, grants accumulate and cannot overflow 2^31−1.
- [ ] Golden test vectors (hex frames and a signed handshake with a fixed key) checked into `src/tunnel/vectors.json` for the engine team.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- `TunnelReject` and the subprotocol header are additions to the spec's three-message handshake. Confirm with the relay lane (R-03) or drop `reject` in favour of WebSocket close codes 4000–4999.
- Initial window and frame size are guesses; R-05 (load test) and the screencast measurement may change them before E-02 freezes the contract.
- Whether OPEN should also carry the SNI hostname (the engine reads it from the ClientHello anyway) is left out deliberately; raise it if the engine team needs it.
