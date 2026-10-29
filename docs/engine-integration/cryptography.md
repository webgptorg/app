# Cryptography: encodings and verification

Every signature the engine makes or checks uses the rules on this page. They come from [ADR 0014](../adr/0014-cryptography.md) and [ADR 0010](../adr/0010-protocol-design-principles.md), and the code in [`@ptbk/protocol`](../../packages/protocol/README.md#wire-formats-under-review) is the reference. If you implement them in another language, your results must match the golden vectors byte for byte.

Spec: [Interfaces (draft)](../spec/zero-trust-spec.md#interfaces-draft), "Signature encoding".

## What the engine must do

**Algorithm**

- The engine must use Ed25519 for every engine-key signature (protocol v1). Keys and signatures carry no algorithm prefix; the algorithm is fixed per protocol version.
- The engine should generate keys and sign with a native implementation that can keep the private key non-extractable at runtime (WebCrypto in Node). See [identity-and-registration.md](identity-and-registration.md#engine-key-handling) for storage.

**Signing input**

- Every engine-key signature must sign `signingInput(context, ...parts)`, never a concatenation of its own:
  - the 9 bytes `"ptbk-sig\0"`,
  - one byte with the length of the context, then the context in ASCII,
  - then for each part: its length as a 4-byte big-endian integer, then its bytes.
- String parts are UTF-8. Binary values (nonces, digests, public keys) go in as raw bytes, never as their base64url text.
- The contexts are a closed list, `SIGNING_CONTEXT`: `ptbk-tunnel-v1`, `ptbk-hostname-v1`, `ptbk-register-v1` and `ptbk-heartbeat-v1`. A new purpose gets a new context; a changed input gets a new version. `signingInput` throws on any other context, because that is a bug.
- Docs, including this guide and the spec, write `"ptbk-x-v1" | a | b` as notation. It always means this encoding, never a `|`-joined string.

**DSSE for release documents**

Release entries and revocation lists are not signed with `signingInput`. They are DSSE envelopes (`DsseEnvelope`) over the exact payload bytes, so nobody has to canonicalise JSON:

- Signatures cover the PAE (`pae`): `"DSSEv1" SP len(type) SP type SP len(body) SP body`, with lengths as ASCII decimal byte counts. A PAE starts with `DSSEv1 `, so it can never collide with a `ptbk-sig\0` input.
- Domain separation is the payload type: `RELEASE_PAYLOAD_TYPE` (`application/vnd.ptbk.release+json; v=1`) and `REVOCATION_PAYLOAD_TYPE` (`application/vnd.ptbk.revocation+json; v=1`).
- `payload` and `sig` are standard base64 with `=` padding, as DSSE and Sigstore require (`encodeBase64Std`, `decodeBase64Std`).
- `keyid` is base64url without padding of SHA-256 over the raw 32-byte public key (`dsseKeyId`).
- `verifyDsseSignatures` returns the set of trusted key IDs with a valid signature: unknown key IDs are ignored and a key that signs twice counts once.

**Byte encodings**

- Every byte string on the wire outside DSSE is base64url without padding (`encodeBase64Url`, `decodeBase64Url`).
- Decoders must accept exactly one encoding per byte string: base64url decoding refuses padding, `+`, `/`, whitespace, a length of 1 mod 4 and non-zero trailing bits; standard base64 decoding refuses `-`, `_`, whitespace, missing padding and non-zero trailing bits.
- Engine IDs and link codes use lowercase RFC 4648 base32 without padding (`encodeBase32Lower`).

**Strict verification**

The engine must accept exactly the signatures that `@noble/curves@2.4.0` accepts with `ed25519.verify(sig, msg, pub, { zip215: false })`, which is what `verifyEd25519` calls. `zip215: false` must be passed, because noble's default is `true`. With it, verification checks, in this order:

1. A and R are canonical encodings (y < p, no negative zero).
2. S < L.
3. A is not of small order.
4. The cofactored equation holds: [8][S]B = [8]R + [8][k]A.

Small-order or mixed-order R, and mixed-order A, are **accepted** when the equation holds. libsodium rejects some of these, so an engine that uses libsodium, WebCrypto or any other library must reproduce noble's results, not its own library's. [`ed25519-vectors.json`](../../packages/protocol/src/ed25519-vectors.json) records noble's actual accept or reject for 21 cases (the ed25519-speccheck set plus constructed edge cases), with a note where libsodium differs. It is the reference: run every vector through your verifier and compare `valid`.

- `verifyEd25519` returns `false`, and never throws, for a key that is not 32 bytes, a signature that is not 64 bytes, or anything noble rejects.
- Signed messages must be verified over the exact bytes received, before parsing them.

**Never compare signatures**

The engine must never compare signature bytes, only verify them. Safari, for example, signs Ed25519 with randomness, so the same message can have two valid signatures. Byte-exact signature vectors exist only for deterministic signers.

**Randomness and secrets**

- Every nonce, token, setup secret and key must come from a CSPRNG (`crypto.getRandomValues` or the platform equivalent; `createCryptoRandom` is the contract's `Random`). Never `Math.random`.
- `bytesEqual` is not constant-time and is meant for public values only (hashes of public data, keys, engine IDs). Secrets must be compared as SHA-256 digests with a constant-time comparison (`crypto.timingSafeEqual` in Node).
- Secrets have at least 128 bits.

## Contract exports

| Need                       | Export                                                                                                                                                 | Source                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Signing input and contexts | `signingInput`, `SIGNING_CONTEXT`, `SigningContext`                                                                                                    | [signing-input.ts](../../packages/protocol/src/signing-input.ts)                                                                                                                                                         |
| Signing and verifying      | `Signer`, `createWebCryptoSigner`, `generateEd25519KeyPair`, `importEd25519PrivateKey`, `verifyEd25519`                                                | [ed25519.ts](../../packages/protocol/src/ed25519.ts)                                                                                                                                                                     |
| Wire forms of keys         | `Ed25519PublicKey`, `Ed25519Signature`, `ed25519PublicKeyFromBytes`, `ed25519PublicKeyToBytes`, `ed25519SignatureFromBytes`, `ed25519SignatureToBytes` | [ids.ts](../../packages/protocol/src/ids.ts)                                                                                                                                                                             |
| Byte encodings             | `encodeBase64Url`, `decodeBase64Url`, `encodeBase64Std`, `decodeBase64Std`, `encodeBase32Lower`, `bytesEqual`, `utf8Encode`                            | [base64url.ts](../../packages/protocol/src/base64url.ts), [base64std.ts](../../packages/protocol/src/base64std.ts), [base32.ts](../../packages/protocol/src/base32.ts), [bytes.ts](../../packages/protocol/src/bytes.ts) |
| DSSE                       | `DsseEnvelope`, `pae`, `dsseKeyId`, `dssePayload`, `signDsse`, `verifyDsseSignatures`, `RELEASE_PAYLOAD_TYPE`, `REVOCATION_PAYLOAD_TYPE`               | [release/dsse.ts](../../packages/protocol/src/release/dsse.ts)                                                                                                                                                           |
| Randomness                 | `Random`, `createCryptoRandom`                                                                                                                         | [random.ts](../../packages/protocol/src/random.ts)                                                                                                                                                                       |

## Golden vectors

- [`ed25519-vectors.json`](../../packages/protocol/src/ed25519-vectors.json): strict verification, generated by running noble and checked against the rule above by [the generator](../../packages/protocol/scripts/generate-ed25519-vectors.ts).
- [`signing-input.test.ts`](../../packages/protocol/src/signing-input.test.ts): the `signingInput` golden hex, with string and binary parts, computed independently.
- [`signed-message-vectors.json`](../../packages/protocol/src/signed-message-vectors.json): full signing inputs for a registration request and a heartbeat, with the RFC 8032 test key.
- [`tunnel/vectors.json`](../../packages/protocol/src/tunnel/vectors.json): the tunnel signing input, part by part.
- [`release/vectors.json`](../../packages/protocol/src/release/vectors.json): the DSSE PAE example, key IDs and signed envelopes.

## Failure handling

- A signature that does not verify is a refusal, never a retry with a different encoding.
- A decoder that sees a non-canonical encoding refuses the whole message.

## Conformance

The ui-loader suite (C-10) checks both: `ui-loader.signature.strict-ed25519` (releases signed with the `ed25519-vectors.json` cases get exactly the recorded accept or reject) and `ui-loader.dsse.pae-only` (a signature over the raw payload, a changed payload byte or a wrong payload type is refused). The tunnel checks in [tunnel-client.md](tunnel-client.md#conformance) exercise `signingInput` through the handshake. The vector files can also be run directly, without an engine.

## Reference implementation

The contract package itself: [ed25519.ts](../../packages/protocol/src/ed25519.ts) and [signing-input.ts](../../packages/protocol/src/signing-input.ts). The mock engine never re-implements them.
