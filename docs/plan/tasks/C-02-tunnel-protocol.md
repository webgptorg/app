# C-02. Tunnel handshake schemas and binary frame codec

- **Lane:** Contracts · **Module:** `packages/protocol` · **Milestone:** M1
- **Depends on:** C-01
- **Status:** in progress (feat/c-02-tunnel-protocol)
- **Spec:** Interfaces (draft) 3. Tunnel protocol, Relay and tunnel; ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md), [0005](../../adr/0005-modular-architecture.md), [0014](../../adr/0014-cryptography.md)

## Goal

`@ptbk/protocol` exports the tunnel handshake messages, the signing helpers for the challenge-response, a binary frame codec and a pure flow-control window, so the relay (R-03, R-04) and the mock engine (M-01) implement both ends from one definition.

## Context

The tunnel is the only path between browsers and engines behind NAT. The relay is public-facing and parses frames from engines it does not trust, so the decoder must never throw, allocate unbounded memory or accept ambiguous input. The spike may replace framing with yamux over WebSocket; keep the codec behind its own module so that swap touches only this file and its two users.

## Scope

- `src/tunnel/constants.ts`: `TUNNEL_PATH = '/v1/tunnel'`, `TUNNEL_SUBPROTOCOL = 'ptbk-tunnel'` (names the protocol only; the version is negotiated in the handshake), `TUNNEL_PROTOCOL_VERSIONS = [1] as const` (versions this package implements), `TUNNEL_FEATURES = [] as const` (feature flags this package knows; empty in v1), `PING_INTERVAL_MS = 25_000`, `AUTH_TIMEOUT_MS = 10_000`, `INITIAL_WINDOW_BYTES = 262_144`, `MAX_FRAME_PAYLOAD_BYTES = 65_536`, `MAX_HANDSHAKE_MESSAGE_BYTES = 4_096`, `NONCE_BYTES = 32`.
- `src/tunnel/close.ts`: `TUNNEL_CLOSE_CODE = { REPLACED: 4000, AUTH_FAILED: 4001, PROTOCOL_ERROR: 4002, SHUTTING_DOWN: 4003, SUSPENDED: 4004 } as const` (WebSocket close codes, private range 4000–4999). These names are the contract; relay, mock engine and docs use them exactly. The one exception to the private range: a `rate-limited` reject is followed by the standard close code 1013 (Try Again Later), so generic WebSocket clients and proxies read it as "retry later"; every other reject closes with a `TUNNEL_CLOSE_CODE` value.
- `src/tunnel/handshake.ts`: strict zod schemas for the JSON text messages, discriminated on `type`, each with `v: 1`:
  - `TunnelChallenge { v, type: 'challenge', nonce: base64url(32 bytes), relayId: RelayId, protocolVersions: number[], features: TunnelFeature[] }`: the relay's own supported versions and features (same bounds as in `auth`), so the engine signs both sides of the negotiation.
  - `TunnelAuth { v, type: 'auth', engineId: EngineId, version: EngineVersion, protocolVersions: number[] (1–8 positive integers, unique), features: TunnelFeature[] (0–32, unique, `[a-z0-9-]{1,32}`), sig: Ed25519Signature }`: every field except `sig` is covered by the signature (`version`, the engine software version, included), so nothing in `auth` is unsigned. Duplicates in either list are rejected by the schema, before any signing input is built.
  - `TunnelReady { v, type: 'ready', protocolVersion: number, features: TunnelFeature[], hostnames: Hostname[] (1–32, unique) }`: `protocolVersion` is the highest version in both lists, `features` exactly the intersection of both feature lists.
  - `TunnelReject { v, type: 'reject', reason: 'auth-failed' | 'suspended' | 'unsupported-version' | 'timeout' | 'rate-limited' }`
  - `negotiateTunnel(relay: { versions, features }, engine: { versions, features })` (pure, used by the relay to build `ready` and by the engine to check it): `{ kind: 'ok', protocolVersion, features } | { kind: 'unsupported-version' }`, picking the highest common version and the exact feature intersection.
  - `checkTunnelReady(challenge, auth, ready)` (engine side): `{ kind: 'ok' } | { kind: 'negotiation-mismatch' }`; the engine closes with `PROTOCOL_ERROR` unless `ready` equals `negotiateTunnel` over the signed lists.
  - `parseRelayMessage(text)` / `parseEngineMessage(text)` returning `{ kind: 'ok', message } | { kind: 'invalid' }`.
- `relayId` is the relay's own hostname (e.g. `relay-fsn.<domain>`), branded `RelayId`, so the signature binds to the relay the engine meant to dial; the engine checks that the challenge's `relayId` equals the hostname it connected to before signing.
- `src/tunnel/auth.ts`: `tunnelAuthInput(challenge, engineId, engine: { version, versions, features })` = `signingInput('ptbk-tunnel-v1', relayId, nonce (raw 32 bytes), engineId, version, relayVersions, relayFeatures, engineVersions, engineFeatures)`. List encoding (exact, part of the wire format): `protocolVersions` sorted numerically ascending, written in decimal without leading zeros; `features` sorted ascending by byte (ASCII order, not locale); each list comma-joined into one UTF-8 part (empty list = empty part), e.g. `[2, 10, 1]` → `"1,2,10"`; `signTunnelAuth(signer, challenge, { version, protocolVersions, features })` (builds the whole `auth` message); `verifyTunnelAuth(publicKey, challenge, auth)`. The relay verifies against the challenge it sent, never against values echoed by the engine.
- `src/tunnel/frame.ts`: `FrameType = { OPEN: 1, DATA: 2, CLOSE: 3, WINDOW: 4 } as const`; `FRAME_IGNORABLE_FLAG = 0x80`; `Frame` discriminated union; `encodeFrame(frame): Bytes`; `decodeFrame(bytes): { kind: 'frame', frame } | { kind: 'ignored', typeCode } | { kind: 'invalid', reason }`; `StreamId` branded (u32, non-zero).
- `src/tunnel/window.ts`: `createSendWindow(initial)` and `createReceiveWindow(initial)`: pure credit accounting (`consume(n)`, `grant(n)`, `available()`), with `{ kind: 'violation' }` when a peer sends beyond credit.

## Out of scope

- WebSocket server and client, sessions, reconnect, proxies (R-03, M-01). SNI parsing (R-01). Registry lookup (C-03, R-02).

## Design notes

- **Protocol design:** follows [ADR 0010](../../adr/0010-protocol-design-principles.md).
- Frame layout per spec: `[u8 type][u32 streamId, big-endian][payload]`, one frame per binary WebSocket message. The layout is unchanged; the type byte splits into a flag bit and a code: bit 7 (`0x80`) is the ignorable flag, bits 0–6 the type code (1–127). A frame whose code the receiver does not know is a protocol error unless the flag is set, in which case `decodeFrame` returns `ignored` after the usual length checks (stream ID not checked, payload ≤ `MAX_FRAME_PAYLOAD_BYTES`) and the receiver drops it. v1 defines no ignorable frames; the four v1 types are always sent with the flag clear, and a known code with the flag set is `invalid` (`bad-flags`).
- **Negotiation (signed, ADR 0014):** the relay lists its versions and features in `challenge`; the engine lists its own in `auth` and signs both lists, so a party in the path (e.g. a TLS-inspecting proxy) cannot strip versions or features to force a downgrade. The relay answers in `ready` (highest common version; exactly the feature intersection), or sends `reject` with `unsupported-version`. The engine recomputes the result from the signed lists and closes with `PROTOCOL_ERROR` on any difference. After `ready`, both sides speak the chosen version and send optional additive fields or ignorable frames only for features both advertised. The handshake messages themselves stay at `v: 1` so any engine can always read a `reject`.
- **Close and reject:** before closing the WebSocket during the handshake the relay sends `reject`; it then closes with `AUTH_FAILED` (`auth-failed`, `timeout`), `SUSPENDED` (`suspended`), `PROTOCOL_ERROR` (`unsupported-version`, or any invalid message or frame) or, for `rate-limited` only, the standard 1013 (Try Again Later); no other reject uses a code outside 4000–4999. After `ready`, `REPLACED` means a newer tunnel for the same engine took over this relay slot (the engine must not reconnect in a loop), `SHUTTING_DOWN` a relay drain (reconnect, preferably elsewhere). Relays map internal outcomes (unknown engine, bad signature, ID/key mismatch, registry unavailable) onto these and reveal nothing finer to the engine.
- `OPEN` payload: `[u8 family: 4 | 6][4 or 16 address bytes][u16 client port, BE]`; exact length, no trailing bytes. Only the relay opens streams; stream IDs increase per tunnel and are never reused.
- `DATA`: raw bytes, 1..`MAX_FRAME_PAYLOAD_BYTES`. `CLOSE`: `[u8 code]` with `CLOSE_CODE = { NORMAL: 0, RESET: 1, REFUSED: 2, TIMEOUT: 3, FLOW_CONTROL: 4 }`. `WINDOW`: `[u32 credit increment, BE]`, 1..2^31−1.
- Invalid reasons: `too-short`, `unknown-type`, `bad-flags`, `stream-id-zero`, `payload-too-large`, `empty-data`, `bad-open-payload`, `bad-close-code`, `bad-window-increment`, `trailing-bytes`. The decoder copies no more than one payload and never reads past the buffer.
- Each direction starts with `INITIAL_WINDOW_BYTES` credit per stream; the receiver grants more with `WINDOW` after delivering bytes downstream. Sending past credit is a protocol violation and the stream is closed with `FLOW_CONTROL`.
- Versioning: the WebSocket subprotocol header only identifies the protocol; the negotiated `protocolVersion` selects the frame codec and message schemas. A `v2` lives next to `v1`, never instead of it, and relays keep N−1 supported.
- Handshake text messages longer than `MAX_HANDSHAKE_MESSAGE_BYTES` are `invalid` without parsing.

## Acceptance criteria

- [ ] Property tests (fast-check): `decodeFrame(encodeFrame(f))` equals `f` for arbitrary valid frames; `decodeFrame` never throws on arbitrary byte arrays up to 128 KiB; every one-byte truncation of a valid frame is `invalid`.
- [ ] Unit tests for each invalid reason, IPv4 and IPv6 `OPEN`, maximum payload accepted, one byte over rejected, `streamId` 0 and 2^32−1; an unknown code with the ignorable flag is `ignored`, without it `unknown-type`.
- [ ] Handshake: unknown field, missing `v`, `v: 2`, 31- and 33-byte nonces, an uppercase engine ID, an empty or duplicated `protocolVersions` and a message over `MAX_HANDSHAKE_MESSAGE_BYTES` are all rejected.
- [ ] `negotiateTunnel`: picks the highest common version, returns only shared features, ignores unknown features, and returns `unsupported-version` with no overlap.
- [ ] Downgrade: `verifyTunnelAuth` fails when any of the four lists in the challenge or `auth` is stripped, reordered into a different set, or altered after signing; `checkTunnelReady` rejects a `ready` with a lower common version, a missing shared feature or an extra feature.
- [ ] `verifyTunnelAuth` passes for a correct signature and fails for a different relay ID, a different nonce, a different engine ID, a changed `version`, another key, and a hostname-claim signature over the same parts.
- [ ] List encoding: `tunnelAuthInput` is identical for lists given in any order (`[2, 10, 1]` encodes as `"1,2,10"`, not `"1,10,2"`); features sort by byte (`"a-b"` before `"ab"`); duplicates and leading-zero forms never reach the encoder because the schema rejects them. The golden vector includes a multi-element version and feature list.
- [ ] Window tests: consume exactly the credit succeeds, one byte more is a violation, grants accumulate and cannot overflow 2^31−1.
- [ ] Golden test vectors (hex frames and a signed handshake with a fixed key) checked into `src/tunnel/vectors.json` for the engine team.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- `reject`, the close codes, the negotiation fields and the extended signing input are additions to the spec's three-message handshake; the spec's Interface 3 must describe them before E-02 (the PR notes the spec change it needs).
- Initial window and frame size are guesses; R-05 (load test) and the screencast measurement may change them before E-02 freezes the contract.
- Whether OPEN should also carry the SNI hostname (the engine reads it from the ClientHello anyway) is left out deliberately; raise it if the engine team needs it.
