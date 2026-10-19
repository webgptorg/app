# C-01. Protocol primitives: branded IDs, base64url, Ed25519, engine ID, hostname claims

- **Lane:** Contracts · **Module:** `packages/protocol` · **Milestone:** M1
- **Depends on:** —
- **Status:** todo
- **Spec:** Interfaces (draft) 1–3, Pairing and identity, Relay and tunnel (Enterprise custom domains); ADRs: [0002](../../adr/0002-public-private-split.md), [0005](../../adr/0005-modular-architecture.md)

## Goal

`@ptbk/protocol` exports the building blocks every wire contract uses: branded identifiers, strict byte encodings, Ed25519 over WebCrypto, engine ID derivation and signed custom-hostname claims, all tested against known vectors.

## Context

Every later contract (tunnel, registration, heartbeat, release log) and three apps (relay, dashboard, mock engine) depend on these functions, and the public engine will too. The wire formats (engine ID derivation, signing inputs) become permanent at publication (E-02); after that, getting one wrong means a `v2` protocol. The TypeScript API may change freely until then. The package moves public in E-02: MIT, no private details, no `node:`/`cloudflare:`/`bun:` or `@ptbk/*` imports.

## Scope

- `src/bytes.ts`: `Bytes` type (`Uint8Array<ArrayBuffer>`), `utf8Encode`, `concatBytes`, `bytesEqual`.
- `src/base64url.ts`: `encodeBase64Url(bytes)`, `decodeBase64Url(text)` returning `{ kind: 'ok', bytes } | { kind: 'invalid' }`. RFC 4648 §5, no padding.
- `src/base32.ts`: `encodeBase32Lower(bytes)` (RFC 4648 alphabet, lowercase, no padding).
- `src/ids.ts`: zod schemas and branded types `EngineId`, `RelayId`, `Hostname`, `EngineVersion` (strict SemVer 2.0), `Timestamp` (RFC 3339 UTC via `z.iso.datetime()`), `Ed25519PublicKey` (base64url of exactly 32 bytes), `Ed25519Signature` (base64url of exactly 64 bytes). The two key types are the wire form (branded base64url strings, as they appear in JSON); crypto functions take `Bytes`. Convert with `ed25519PublicKeyFromBytes` / `ed25519PublicKeyToBytes` and `ed25519SignatureFromBytes` / `ed25519SignatureToBytes` (the `To` direction cannot fail, because the brand guarantees the length).
- `src/ed25519.ts`: `Signer` port (`publicKey(): Bytes; sign(message: Bytes, signal?: AbortSignal): Promise<Bytes>`); `createWebCryptoSigner(keyPair): Promise<Signer>` (async: exports the raw public key once at creation, so `publicKey()` stays synchronous); `generateEd25519KeyPair({ extractable }): Promise<CryptoKeyPair>` (`extractable: true` only where the key must be persisted, e.g. the mock engine); `importEd25519PrivateKey(seed: Bytes, { extractable }): Promise<CryptoKeyPair>`, which wraps the 32-byte RFC 8032 seed in a fixed PKCS#8 prefix (used for the RFC 8032 vectors and for loading a stored key; the public half comes from the JWK `x` of a temporary extractable import, since WebCrypto cannot derive it otherwise); `verifyEd25519(publicKey: Bytes, message: Bytes, signature: Bytes): Promise<boolean>`.
- `src/engine-id.ts`: `deriveEngineId(publicKey: Bytes): Promise<EngineId>`, `defaultHostname(engineId, engineDomain): Hostname`, `engineIdFromDefaultHostname(hostname, engineDomain)` returning `{ kind: 'default', engineId } | { kind: 'custom' } | { kind: 'invalid' }`: `custom` when the hostname is not under `engineDomain`; `invalid` when it is, but is not exactly `<valid engine ID>.<engineDomain>`.
- `src/signing-input.ts`: `signingInput(context, ...parts)` used by every signature in the protocol.
- `src/hostname-claim.ts`: `signHostnameClaim(signer, hostname, engineId)`, `verifyHostnameClaim(publicKey, hostname, engineId, sig)`.
- `src/index.ts` re-exports the public API (named exports only). Add `zod` from the workspace catalog (`"zod": "catalog:"`) as the only runtime dependency, `fast-check` (4.x) as a dev dependency.

## Out of scope

- Tunnel handshake and frames (C-02); registration, registry, heartbeat schemas (C-03); release log (C-06).
- Key storage on disk (engine, mock engine M-01).

## Design notes

- **Protocol design:** every contract in this package follows [ADR 0010](../../adr/0010-protocol-design-principles.md) (versioned messages, negotiated versions, domain-separated `ptbk-<purpose>-v<n>` signing contexts, canonical encodings, explicit limits). Check its rule on algorithm tags for keys and signatures on the wire; if it requires a prefix, the `Ed25519PublicKey` and `Ed25519Signature` schemas are the one place to add it.
- **Engine ID:** SHA-256 over the raw 32-byte public key (not its base64url text), base32 lowercase, first 26 characters (130 bits). Lowercase because hostnames are case-insensitive. `EngineId` schema: `/^[a-z2-7]{26}$/`.
- **Signing input:** UTF-8 of `context|part1|part2…` with `|` as separator. Every part is a string from a schema that cannot contain `|` (hostnames, engine IDs, relay IDs, base64url), so the encoding is unambiguous; `signingInput` throws on a part containing `|` (a bug, not an input). Hostname claim: `signingInput('ptbk-hostname-v1', hostname, engineId)`. Binary values (nonces) are passed as their base64url wire form.
- **Hostname:** ASCII only (IDN must arrive as A-labels), lowercased by the parser, 1–253 chars, at least two labels, labels 1–63 of `[a-z0-9-]` without leading or trailing hyphen, no trailing dot, not an IPv4/IPv6 literal.
- **RelayId:** the relay's own hostname (e.g. `relay-fsn.<domain>`), parsed with the `Hostname` rules and branded separately, so a tunnel signature binds to the exact relay the engine dialled (decided 2026-10-19, see C-02).
- **base64url decode** rejects padding, `+`, `/`, whitespace, length ≡ 1 mod 4 and non-zero trailing bits (non-canonical), so each byte string has exactly one accepted encoding.
- `verifyEd25519` returns `false` (never throws) for a signature that is not 64 bytes, a key that is not 32 bytes, or a key WebCrypto rejects. Keys are imported non-extractable, usage `['verify']`.
- Imports are extensionless (`moduleResolution: "Bundler"`); Node apps that use the package are bundled, so no `.ts`/`.js` suffixes.
- Portable typing: the package's `tsconfig.json` adds `"DOM"` to `lib` for `crypto.subtle` and `TextEncoder`; add an ESLint `no-restricted-globals` rule for `window`, `document`, `localStorage` in contract packages so DOM typing does not invite browser-only code.

## Acceptance criteria

- [ ] Ed25519 tests pass the RFC 8032 §7.1 vectors (TEST 1–3) for sign and verify; a flipped bit in message, key or signature fails verification.
- [ ] Engine ID test: a fixed public key gives a fixed, checked-in engine ID (computed independently, e.g. with `openssl dgst -sha256` and a base32 tool, noted in the test); output always matches the schema.
- [ ] base64url property tests (fast-check): `decode(encode(b))` equals `b` for arbitrary bytes; `decode` never throws on arbitrary strings; every non-canonical variant of a valid string is rejected.
- [ ] Hostname tests cover: uppercase input normalised, trailing dot, empty label, 64-char label, 254-char name, leading hyphen, `_`, Unicode, IPv4 and `[::1]` literals, single label.
- [ ] Hostname claim: sign then verify passes; verify fails for another hostname, another engine ID, another key, and a claim made with the tunnel context.
- [ ] Every schema rejects unknown fields where it is an object, and every branded value can only be created through its schema or parser.
- [ ] `bun run check` passes; ESLint confirms no platform or `@ptbk/*` imports.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Merge after self-review. The wire formats (engine ID alphabet, truncation and hash input; the `|` signing-input encoding) are reviewed by the engine team and Pavol (crypto review) before E-02, which is a hard gate; record them in the package README so that review has one place to look.
- Ed25519 in WebCrypto needs Node ≥ 22 (fine), current Workers, Chrome 137+, Safari 17+, Firefox 129+. Tests run on Node only; flag if a Workers test pool is wanted.
