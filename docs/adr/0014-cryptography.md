# 0014. Cryptographic primitives, encodings and libraries

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

An independent review of the planned cryptography (2026-10-19) found the design sound but identified three risks to fix before the wire formats freeze (E-02): the tunnel version negotiation was not signed (downgrade), the update delay could be shortened by a backdated timestamp, and Sigstore identity matching was an unanchored pattern. It also recommended removing two sources of ambiguity: JSON canonicalisation and `|`-joined signature inputs. This ADR records the resulting choices; [ADR 0010](0010-protocol-design-principles.md) states the principles.

## Decision

**Signatures**

- Ed25519 only (v1). **WebCrypto** generates keys and signs (native, non-extractable at runtime). **`@noble/curves`** verifies everywhere with `zip215: false` (it must be passed; the default is `true`): canonical encodings of A and R, S < L, A not of small order, cofactored equation. Its accept/reject results on the edge-case vectors (small- and mixed-order points, non-canonical encodings) are recorded in the protocol package and are the reference every implementation must match, so Node, Workers, browsers and the engine team's stack accept exactly the same signatures.
- **Signature inputs are length-prefixed:** `"ptbk-sig\0" ‖ u8 len(context) ‖ context ‖ (u32be len ‖ bytes)…`. Binary values go in as raw bytes. Every context is versioned (`ptbk-<purpose>-v<n>`).
- **No JSON canonicalisation.** Signed documents (release entries, revocation lists) are **DSSE envelopes** over the exact payload bytes; release and maintainer keys sign the DSSE PAE, and CI provenance is `sigstore.attest()` over the same envelope. Their domain separation is the DSSE `payloadType` (`application/vnd.ptbk.release+json; v=1`, `…revocation+json; v=1`), not a `signingInput` context; a PAE (`DSSEv1 …`) can never collide with a `ptbk-sig\0` input. Messages like the heartbeat sign the exact bytes sent.
- **The tunnel handshake signs everything in `auth`:** relay ID, nonce, engine ID, engine software version and both sides' version and feature lists (canonically ordered); the engine checks the relay's choice, so negotiation cannot be downgraded.

**Releases**

- A regular release needs the CI's keyless Sigstore signature and the human-held release key (Ed25519 on a hardware key, e.g. YubiKey PIV); security releases also need 2 of 3 maintainer keys.
- Sigstore identity is pinned exactly: issuer, repository, repository ID, workflow path and tag, the commit digest and a GitHub-hosted runner. No caller-supplied patterns. Verification is built on `@sigstore/verify` directly (exact SAN and decoded certificate extensions; `sigstore.verify()` matches identities by unanchored pattern). A pinned trust root ships with releases. Release and maintainer key sets may not overlap.
- The update delay counts from the latest of `publishedAt`, a verified trusted timestamp (RFC 3161 TSA or Rekor integrated time) and the engine's persisted first-seen time.
- Revocations are a signed, expiring list; an expired list means "keep the current version and alert", and a list older than the newest one already accepted is refused (no rollback).

**Secrets and randomness**

- Randomness only from `crypto.getRandomValues` (ESLint bans `Math.random`).
- Secrets have at least 128 bits (dashboard session, email and relay tokens 256; link codes 128 on purpose: short-lived, single-use, rate-limited) and are stored as SHA-256 hashes and looked up by hash; unavoidable direct comparisons use `crypto.subtle.timingSafeEqual` (Workers) or `crypto.timingSafeEqual` (Node) on digests.
- Relay tokens are prefixed (`ptbk_rt_`) for secret scanning, rotate with two live tokens, and expire.

**Transport and identity**

- The relay's own TLS listener sets TLS 1.2 minimum with AEAD-only ciphers (TLS 1.3 minimum once proxy tests allow); engine TLS is TLS 1.3 only.
- The dev CA is name-constrained to development domains.
- WebAuthn on the dashboard: user verification required, challenges consumed atomically, `userHandle` checked in usernameless sign-in, counter regressions flagged.
- **Custom domains are bound in DNS:** a custom hostname must CNAME to the engine's default hostname, and the relay routes it only if the engine-signed claim verifies and the CNAME points at that engine. A compromised dashboard cannot redirect a customer's domain. Conflicting claims route nowhere.
- Engine keys cannot rotate in place (the engine ID is the key's hash). After a compromise, the owner revokes the engine in the dashboard and sets it up again with a new identity.

**Libraries** (exact versions pinned in the briefs): `@noble/curves`, `sigstore`, `@simplewebauthn/server` and `@simplewebauthn/browser`, `@peculiar/x509`, `stripe` (webhook verification via WebCrypto). `acme-client` only for the Pebble spike; the production ACME client is the engine team's choice.

## Consequences

- Identical verification semantics on every runtime; a little more code than calling WebCrypto alone.
- Signed formats are unambiguous by construction and need no canonicaliser.
- Downgrade and backdating attacks are closed before the formats freeze.
- The engine team implements the same encodings; the vectors and the conformance suite in `packages/protocol` and `packages/conformance` are the reference.
