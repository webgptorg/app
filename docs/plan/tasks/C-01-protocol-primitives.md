# C-01. Protocol primitives: branded IDs, base64url, Ed25519, engine ID, hostname claims

- **Lane:** Contracts · **Module:** `packages/protocol` · **Milestone:** M1
- **Depends on:** —
- **Status:** in progress (feat/c-01-protocol-primitives)
- **Spec:** Interfaces (draft) 1–3, Pairing and identity, Relay and tunnel (Enterprise custom domains); ADRs: [0002](../../adr/0002-public-private-split.md), [0005](../../adr/0005-modular-architecture.md), [0014](../../adr/0014-cryptography.md)

## Goal

`@ptbk/protocol` exports the building blocks every wire contract uses: branded identifiers, strict byte encodings, a `Random` port, Ed25519 (WebCrypto signing, strict `@noble/curves` verification), the length-prefixed signing input, engine ID derivation and signed custom-hostname claims, all tested against known vectors.

## Context

Every later contract (tunnel, registration, heartbeat, release log) and three apps (relay, dashboard, mock engine) depend on these functions, and the public engine will too. The wire formats (engine ID derivation, signing inputs) become permanent at publication (E-02); after that, getting one wrong means a `v2` protocol. The TypeScript API may change freely until then. The package moves public in E-02: MIT, no private details, no `node:`/`cloudflare:`/`bun:` or `@ptbk/*` imports.

## Scope

- `src/bytes.ts`: `Bytes` type (`Uint8Array<ArrayBuffer>`), `utf8Encode`, `concatBytes`, `bytesEqual`. `bytesEqual` is documented as **not constant-time**: for public values only (hashes of public data, keys, engine IDs). Secrets are compared as SHA-256 digests with the platform's `timingSafeEqual` in the app that holds them, never here.
- `src/random.ts`: `Random` port (`bytes(length: number): Bytes`) and `createCryptoRandom()` backed by `crypto.getRandomValues` (filled in chunks of at most 65,536 bytes, the API's limit). The only source of tokens, nonces and link codes; a seeded fake lives under `src/testing/` for tests and must never be wired by app config outside tests.
- `src/base64url.ts`: `encodeBase64Url(bytes)`, `decodeBase64Url(text)` returning `{ kind: 'ok', bytes } | { kind: 'invalid' }`. RFC 4648 §5, no padding.
- `src/base32.ts`: `encodeBase32Lower(bytes)` (RFC 4648 alphabet, lowercase, no padding).
- `src/ids.ts`: zod schemas and branded types `EngineId`, `RelayId`, `Hostname`, `EngineVersion` (strict SemVer 2.0), `Timestamp` (RFC 3339 UTC via `z.iso.datetime()`), `Ed25519PublicKey` (base64url of exactly 32 bytes), `Ed25519Signature` (base64url of exactly 64 bytes). The two key types are the wire form (branded base64url strings, as they appear in JSON); crypto functions take `Bytes`. Convert with `ed25519PublicKeyFromBytes` / `ed25519PublicKeyToBytes` and `ed25519SignatureFromBytes` / `ed25519SignatureToBytes` (the `To` direction cannot fail, because the brand guarantees the length).
- `src/ed25519.ts`: `Signer` port (`publicKey(): Bytes; sign(message: Bytes, signal?: AbortSignal): Promise<Bytes>`); `createWebCryptoSigner(keyPair): Promise<Signer>` (async: exports the raw public key once at creation, so `publicKey()` stays synchronous); `generateEd25519KeyPair({ extractable }): Promise<CryptoKeyPair>` (WebCrypto; `extractable: true` only where the key must be persisted, e.g. the mock engine; runtime keys are non-extractable); `importEd25519PrivateKey(seed: Bytes, { extractable }): Promise<CryptoKeyPair>`, which wraps the 32-byte RFC 8032 seed in a fixed PKCS#8 prefix (used for the RFC 8032 vectors and for loading a stored key; the public half is `ed25519.getPublicKey(seed)` from `@noble/curves`, imported as a raw public key); `verifyEd25519(publicKey: Bytes, message: Bytes, signature: Bytes): boolean` (strict, below).
- `src/engine-id.ts`: `deriveEngineId(publicKey: Bytes): Promise<EngineId>`, `defaultHostname(engineId, engineDomain): Hostname`, `engineIdFromDefaultHostname(hostname, engineDomain)` returning `{ kind: 'default', engineId } | { kind: 'custom' } | { kind: 'invalid' }`: `custom` when the hostname is not under `engineDomain`; `invalid` when it is, but is not exactly `<valid engine ID>.<engineDomain>`.
- `src/signing-input.ts`: `signingInput(context: SigningContext, ...parts: (string | Bytes)[]): Bytes` used by every engine-key signature in the protocol, and `SIGNING_CONTEXT` (`ptbk-tunnel-v1`, `ptbk-hostname-v1`, `ptbk-register-v1`, `ptbk-heartbeat-v1`). Release and revocation documents are signed as DSSE envelopes instead (C-06).
- `src/hostname-claim.ts`: `signHostnameClaim(signer, hostname, engineId)`, `verifyHostnameClaim(publicKey, hostname, engineId, sig)`.
- `src/index.ts` re-exports the public API (named exports only). Runtime dependencies from the workspace catalog: `zod` and `@noble/curves` (this task adds `"@noble/curves": "2.4.0"` to the root `package.json` catalog); `fast-check` (4.x) as a dev dependency.

## Out of scope

- Tunnel handshake and frames (C-02); registration, registry, heartbeat schemas (C-03); release log (C-06).
- Key storage on disk (engine, mock engine M-01).

## Design notes

- **Protocol design:** every contract in this package follows [ADR 0010](../../adr/0010-protocol-design-principles.md) (versioned messages, negotiated versions, domain-separated `ptbk-<purpose>-v<n>` signing contexts, canonical encodings, explicit limits). Keys and signatures carry **no algorithm prefix** (ADR 0010 §7): the algorithm is fixed per protocol version (Ed25519 in v1), so `Ed25519PublicKey` and `Ed25519Signature` are plain base64url; a new algorithm arrives as a new negotiated version. The heartbeat header's `ed25519=` label (C-03) stays because the header already names the algorithm.
- **Engine ID:** SHA-256 over the raw 32-byte public key (not its base64url text), base32 lowercase, first 26 characters (130 bits). Lowercase because hostnames are case-insensitive. `EngineId` schema: `/^[a-z2-7]{26}$/`.
- **Signing input** (length-prefixed, ADR 0014): `"ptbk-sig\0"` ‖ u8 len(context) ‖ context (ASCII) ‖ for each part: u32 big-endian length ‖ bytes. String parts are UTF-8; binary values (nonces, hashes, public keys) are passed as raw `Bytes`, never as base64url text. The encoding is unambiguous for any part content, so no separator check exists. `signingInput` throws only on a context outside `SIGNING_CONTEXT` (a bug, not an input). Docs may write `"ptbk-x-v1" | a | b` as notation but must say it is encoded with `signingInput`. Hostname claim: `signingInput('ptbk-hostname-v1', hostname, engineId)`. The `ptbk-sig\0` prefix can never be a DSSE PAE (which starts with `DSSEv1 `), so an engine-key signature and a release signature cannot be confused.
- **Hostname:** ASCII only (IDN must arrive as A-labels), lowercased by the parser, 1–253 chars, at least two labels, labels 1–63 of `[a-z0-9-]` without leading or trailing hyphen, no trailing dot, not an IPv4/IPv6 literal.
- **RelayId:** the relay's own hostname (e.g. `relay-fsn.<domain>`), parsed with the `Hostname` rules and branded separately, so a tunnel signature binds to the exact relay the engine dialled (decided 2026-10-19, see C-02).
- **base64url decode** rejects padding, `+`, `/`, whitespace, length ≡ 1 mod 4 and non-zero trailing bits (non-canonical), so each byte string has exactly one accepted encoding.
- **Verification:** `verifyEd25519` calls `ed25519.verify(sig, msg, pub, { zip215: false })` from `@noble/curves@2.4.0` (import path `@noble/curves/ed25519.js`; v2 requires the `.js` subpath). noble's default is `zip215: true`, so `false` must be passed explicitly. With it, noble checks exactly: canonical A and R encodings (y < p, no negative zero), S < L, A not of small order, then the cofactored verification equation. Small-order or mixed-order R, and mixed-order A, are **accepted** when the equation holds (libsodium rejects some of these; we follow noble, not libsodium). That rule, not "RFC 8032 strict" in the abstract, is the protocol's definition of a valid signature. WebCrypto is never used to verify, because implementations differ on these edge cases and every party (relay, dashboard, engine, browser) must accept exactly the same signatures. It returns `false` (never throws) for a signature that is not 64 bytes, a key that is not 32 bytes, or anything noble rejects or throws on.
- **Signing** stays in WebCrypto so private keys can be non-extractable. Safari signs Ed25519 randomised (hedged), so tests and code never compare signature bytes from a browser, only verify them; byte-exact signature vectors are produced and checked on Node only.
- Imports are extensionless (`moduleResolution: "Bundler"`); Node apps that use the package are bundled, so no `.ts`/`.js` suffixes.
- Portable typing: the package's `tsconfig.json` adds `"DOM"` to `lib` for `crypto.subtle` and `TextEncoder`; add an ESLint `no-restricted-globals` rule for `window`, `document`, `localStorage` in contract packages so DOM typing does not invite browser-only code, and a repo-wide `no-restricted-properties` rule banning `Math.random`.

## Acceptance criteria

- [ ] Ed25519 tests pass the RFC 8032 §7.1 vectors (TEST 1–3) for sign (Node) and verify; a flipped bit in message, key or signature fails verification; `importEd25519PrivateKey` yields the vectors' public keys.
- [ ] Strict-verification edge cases are checked in as `src/ed25519-vectors.json` and asserted: the "Taming the many EdDSAs" vectors (small-order A and R, mixed-order A and R, non-canonical R and A encodings including negative zero, S ≥ L, S just below L). Each vector records noble's **actual** accept/reject with `{ zip215: false }` (generated by running noble, then reviewed against the rule above: small-order A rejected, small- or mixed-order R and mixed-order A accepted when the equation holds), plus a note where libsodium differs. This file is the cross-implementation reference the engine team must match; the test fails on any drift, e.g. after a noble upgrade.
- [ ] `signingInput`: a golden hex vector with string and `Bytes` parts; `('ab', 'c')` and `('a', 'bc')` encode differently; an empty part and a part containing `|` or `\0` are fine; an unknown context throws.
- [ ] `createCryptoRandom().bytes(n)` returns `n` bytes for 0, 1, 65,536 and 100,000; ESLint fails on `Math.random`.
- [ ] Engine ID test: a fixed public key gives a fixed, checked-in engine ID (computed independently, e.g. with `openssl dgst -sha256` and a base32 tool, noted in the test); output always matches the schema.
- [ ] base64url property tests (fast-check): `decode(encode(b))` equals `b` for arbitrary bytes; `decode` never throws on arbitrary strings; every non-canonical variant of a valid string is rejected.
- [ ] Hostname tests cover: uppercase input normalised, trailing dot, empty label, 64-char label, 254-char name, leading hyphen, `_`, Unicode, IPv4 and `[::1]` literals, single label.
- [ ] Hostname claim: sign then verify passes; verify fails for another hostname, another engine ID, another key, and a claim made with the tunnel context.
- [ ] Every schema rejects unknown fields where it is an object, and every branded value can only be created through its schema or parser.
- [ ] `bun run check` passes; ESLint confirms no platform or `@ptbk/*` imports.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Merge after self-review. The wire formats (engine ID alphabet, truncation and hash input; the length-prefixed signing input; the exact noble verification rule and its vectors) are reviewed by the engine team and Pavol (crypto review) before E-02, which is a hard gate; record them in the package README so that review has one place to look.
- Ed25519 in WebCrypto needs Node ≥ 22 (fine), current Workers, Chrome 137+, Safari 17+, Firefox 129+. Tests run on Node only; flag if a Workers test pool is wanted.
- `@noble/curves` is the protocol's second runtime dependency and sits on every verification path; pin the exact version and review upgrades like a protocol change.
