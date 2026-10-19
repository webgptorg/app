# 0010. Protocol design principles

- **Status:** Accepted
- **Date:** 2026-10-19

## Context

The wire contracts in `packages/protocol` and `packages/engine-api` will be spoken by engines installed on customers' servers, which update on their own schedule and may lag for months. Once engines ship, a careless format change strands them. We want few changes ever, and changes that do come to be additive and negotiated. Until the contracts are published (task E-02), formats can still change cheaply; E-02 is the freeze point and is gated on a review by the engine team and Pavol.

## Decision

1. **Every message is versioned.** JSON messages carry `v`; HTTP APIs are versioned by path (`/v1`); the tunnel negotiates.
2. **Negotiate, don't assume.** In the tunnel handshake the engine advertises the protocol versions and optional features it supports; the relay answers with the version it chose and the features it accepts. Optional behaviour is used only when both sides agreed to it.
3. **Change by addition.** A breaking change is a new version next to the old one; relays and the dashboard support the current and the previous version at least. Within a version, a new field is optional and only sent when the peer advertised the feature that introduced it. Schemas stay strict (unknown fields rejected), so nothing drifts silently.
4. **Room to grow in binary framing.** Frame types live in a registry with reserved ranges; one bit marks a frame type as ignorable, so a peer may skip unknown ignorable frames and must close the stream with a protocol error for unknown non-ignorable ones. Lengths are explicit and bounded by named constants.
5. **Domain-separated, versioned signatures.** Every signature covers a context `ptbk-<purpose>-v<n>` followed by its parts, length-prefixed so the encoding is unambiguous by construction ([ADR 0014](0014-cryptography.md)). A new signature purpose gets a new context; a changed input gets a new version. Negotiated parameters are inside the signature, so they cannot be downgraded.
6. **Sign exact bytes, never re-serialised JSON.** Signed documents are DSSE envelopes over the exact payload bytes; signed messages sign the bytes as sent. Byte strings on the wire are base64url without padding, with exactly one accepted encoding, except inside DSSE envelopes, which use standard base64 with padding as DSSE and Sigstore do (equally strict: one accepted encoding).
7. **Algorithm agility through versions.** The signature algorithm is fixed per protocol version (Ed25519 in v1), so keys and signatures stay plain base64url on the wire; where a header already names the algorithm (`Ptbk-Signature: ed25519=…`), that stays. A new algorithm arrives as a new, negotiated version.
8. **Explicit limits and errors.** Maximum sizes, timeouts and rate limits are named constants in the contract. Errors are typed: closed enums of reasons and close codes, problem+json on HTTP.
9. **Reviewed before freeze.** Engine ID derivation, signing inputs, frame layout and handshake are reviewed by the engine team and Pavol before E-02 publishes them.

## Consequences

- New capabilities (another transport, compression, a new frame type) can be added without breaking deployed engines.
- A little more ceremony now: version fields, feature lists, a frame-type registry.
- The conformance suite tests negotiation and the reject paths, not just the happy path.
