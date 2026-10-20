# @ptbk/protocol

Wire contracts between the engine, the relay and the dashboard (spec, Interfaces 1 to 5): engine IDs and hostname claims, engine registration, registry lookup, tunnel handshake and frame codec, heartbeat, and the release log with its verification. zod schemas, strict and versioned.

It also holds the TLS ClientHello parser (`parseClientHello`, `createClientHelloBuffer`) that the relay routes on and engines use to spot `acme-tls/1`. It is total over untrusted bytes, bounded by `maxBytes`, and fuzzed with fast-check. Its fixtures in `src/tls/fixtures/` are real ClientHellos captured with `scripts/capture-client-hello.ts`, which documents how each was made.

MIT, Web APIs only (`crypto.subtle`, streams), no imports from `@ptbk/*`, so it runs in Node, Workers and browsers and can move to the public repo unchanged ([ADR 0002](../../docs/adr/0002-public-private-split.md)). Plan: tasks C-01, C-02, C-03, C-06, R-01.

## Wire formats under review

These freeze at publication (E-02) after review by the engine team and Pavol ([ADR 0010](../../docs/adr/0010-protocol-design-principles.md), [ADR 0014](../../docs/adr/0014-cryptography.md)). This is the one place to review them.

- **Byte strings** are base64url (RFC 4648 §5) without padding. The decoder rejects padding, `+`, `/`, whitespace, a length ≡ 1 (mod 4) and non-zero trailing bits, so each byte string has exactly one accepted encoding.
- **Keys and signatures** carry no algorithm prefix: Ed25519 is fixed in v1. `Ed25519PublicKey` is base64url of exactly 32 bytes, `Ed25519Signature` of exactly 64.
- **Engine ID**: SHA-256 over the raw 32-byte public key (not its base64url text), base32 (RFC 4648 alphabet) lowercase, first 26 characters (130 bits), `/^[a-z2-7]{26}$/`. The default hostname is `<engineId>.<engine domain>`; any other name inside the engine domain, including the domain itself, is invalid, never custom.
- **Hostname**: ASCII only (IDN as A-labels), lowercased, at most 253 characters, at least two labels of 1–63 `[a-z0-9-]` without leading or trailing hyphen, no trailing dot. A last label that is a number (decimal or `0x` hex) is refused, because browsers parse such a host as IPv4. `RelayId` is a `Hostname` branded separately.
- **Signing input**: `signingInput(context, ...parts)` = `"ptbk-sig\0" ‖ u8 len(context) ‖ context ‖ (u32be len(part) ‖ part)…`. Strings are UTF-8; binary values (nonces, hashes, keys) are raw bytes. Contexts: `ptbk-tunnel-v1`, `ptbk-hostname-v1`, `ptbk-register-v1`, `ptbk-heartbeat-v1`. A hostname claim is Ed25519 over `signingInput('ptbk-hostname-v1', hostname, engineId)`.
- **Verification**: `@noble/curves` 2.4.0, `ed25519.verify(sig, msg, pub, { zip215: false })`: canonical A and R (y < p, no negative zero), S < L, A not of small order, then the cofactored equation. Small- or mixed-order R and mixed-order A are accepted when the equation holds (libsodium rejects them). [`src/ed25519-vectors.json`](src/ed25519-vectors.json) records the result for each edge case and is the reference other implementations must match; `bun run --filter @ptbk/protocol generate-vectors` regenerates it and refuses if noble disagrees with this rule. WebCrypto only generates keys and signs (non-extractable at runtime); it never verifies.
