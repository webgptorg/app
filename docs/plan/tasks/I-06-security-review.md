# I-06. Internal security review gate

- **Lane:** I · **Module:** `docs/security-review/` · **Milestone:** M4
- **Depends on:** I-01, I-02, I-03, I-04, I-05, R-06, X-04, X-05
- **Status:** todo
- **Spec:** Build plan (Gate to v0 release); Security goals and threat model; Residual risks; What our platform can and cannot do; Metadata we still see; Security hardening item 10; docs/security.md; ADRs: [0014](../../adr/0014-cryptography.md)

## Goal

The v0 release has passed the internal review gate: a threat model walkthrough, a pen test by David, a cryptography and key-handling review of the protocol and relay by Pavol, and an onboarding review by Anka, with every finding tracked and the blocking ones fixed and re-tested.

## Context

The spec makes this review the gate between v0 and release; an external audit comes later, before general availability. The reviewers are people, not agents. The coding agent's job is to prepare everything so the reviewers spend their time on breaking things, then to track and fix findings. This repo covers our side (relay, dashboard, engine-ui, release pipeline); the engine's own review happens in the public repo, but the boundary (contracts, conformance) is in scope here.

## Scope

- `docs/security-review/v0/threat-model.md`: each attacker from the spec's table and each guarantee in docs/security.md mapped to the control that enforces it, the test that proves it (file path or e2e name) and the residual risk. Include the organization model (ADR 0006), dashboard recovery and its 72-hour cooldown, and the release pipeline.
- `docs/security-review/v0/scope.md`: environments (staging only, matching production config), accounts and test engines provided, rules of engagement, out-of-scope items, contact during testing.
- Checklists, one file per reviewer:
  - **Pen test (David):** dashboard auth, sessions, CSRF, recovery flow and enumeration, org isolation (IDOR across orgs), admin step-up, registration, heartbeat replay and forgery, registry API auth, Stripe webhook, rate limits; relay SNI parsing (malformed and fragmented ClientHello), unknown SNI handling, tunnel auth, fairness limits, resource exhaustion (pre-ClientHello and IPv6-prefix floods, slow-reading browsers against the memory budget, streams outliving their sockets, a hostile engine sending tiny WINDOW grants, ignorable frames, stale `CLOSE`s and ping floods), R-06's crash containment; host exposure (ports, SSH).
  - **Crypto and keys (Pavol):** checked against ADR 0014. Engine ID derivation and base32 encoding; Ed25519 usage (WebCrypto signing, non-extractable keys) and every verification path going through `@noble/curves@2.4.0` `ed25519.verify(sig, msg, pub, { zip215: false })` (passed explicitly, the default is `true`), which checks canonical A and R encodings, S < L, A not of small order, then the cofactored equation; small- or mixed-order R and mixed-order A pass when the equation holds (libsodium differs), so check that `ed25519-vectors.json` records noble's actual accept or reject per vector (RFC 8032 and "Taming the many EdDSAs" cases) and serves as the reference the engine team matches; the length-prefixed `signingInput` and its domain-separation contexts (`ptbk-tunnel-v1`, `ptbk-hostname-v1`, `ptbk-register-v1`, `ptbk-heartbeat-v1`); DSSE envelopes and PAE for release and revocation documents (payload parsed only after verification, `keyid` derivation); the signed tunnel negotiation (downgrade protection, `ready` check on the engine) and that the engine software `version` is inside the `ptbk-tunnel-v1` signing input, so nothing in `auth` is unsigned; challenge nonce generation and freshness; relay checks that the engine ID matches the key from the registry; the custom-domain binding (the relay routes a custom hostname only when its `ptbk-hostname-v1` claim verifies and its CNAME equals `<engineId>.<engine domain>` through the cached `DnsResolver`, the 24 h stale rule on DNS failure, and `hostname.conflict` when two connected engines claim one hostname), so a compromised dashboard cannot redirect a customer domain; the registration proof of possession (C-03/D-03) and the heartbeat hash input; release trusted-time logic (`eligibleAt` from `publishedAt`, the latest verified TSA or Rekor time and `firstSeenAt`), revocation list expiry and rollback protection inside `verifyRelease`; the `TrustPolicy` schema rejecting a key in both `releaseKeys` and `maintainerKeys` and requiring 3 distinct maintainer keys; Sigstore identity pinning (exact SAN, certificate extension OIDs, no caller patterns, cosign flags without `--certificate-identity-regexp`) and the `ProvenanceVerifier` adapter built on `@sigstore/verify@4.1.2` rather than `sigstore.verify()` (exact SAN string compare, each OID decoded as a DER UTF8String and compared exactly, `tlogThreshold` and `ctlogThreshold` 1, pinned trusted root, `trustedTime` = the latest verified timestamp); token generation (`Random` only), the relay token format and hash lookup, and the remaining constant-time comparisons; the WebAuthn `userHandle` check, challenge consumption and counter handling (D-02); relay TLS settings and key handling; release signing and the UI bundle verification inputs.
  - **Onboarding (Anka):** signup, link code and install command, first heartbeat, opening the engine, recovery, English and Czech copy, error states, passkey prompts on Windows, macOS, Linux and mobile.
- **Formats review before E-02:** separate from and earlier than this gate, the engine team and Pavol review the wire formats (engine ID derivation, signing inputs, frame layout) before they become permanent at publication (E-02), per [ADR 0010](../../adr/0010-protocol-design-principles.md). Record the outcome in `docs/security-review/formats.md`; E-02 does not start without it.
- Tracking: every finding becomes a GitHub issue labelled `security-review-v0` with severity (critical, high, medium, low), owner and linked fix PR. `docs/security-review/v0/findings.md` lists them with status.
- Re-test: each critical and high fix is re-tested by the reviewer who found it.
- Sign-off: `docs/security-review/v0/sign-off.md` with each reviewer's name, date, scope covered and verdict.

## Out of scope

- The external audit before general availability; the engine's internal review (public repo); bug bounty.

## Design notes

- Gate rule: no open critical or high finding, unless a maintainer accepts it in writing with an ADR (for anything touching a guarantee in AGENTS.md) and a date to fix. Mediums have an owner and a target milestone.
- Evidence beats claims: link the packet capture test (X-02), the schema allowlist test (D-01), the CSP tests, the relay log field allowlist (I-04) and `verify.sh` runs (I-01) in the threat model.
- Findings and exploit details stay in the private repo; nothing goes into public issues.

## Acceptance criteria

- [ ] Threat model, scope and three checklists merged before testing starts, reviewed by at least one maintainer.
- [ ] All findings filed as labelled issues; `findings.md` matches them.
- [ ] No open critical or high findings, or written acceptance with an ADR for each.
- [ ] Sign-off file contains David, Pavol and Anka's verdicts.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Apply (needs credentials)

Tracked in [apply.md](../apply.md). Threat model, scope and checklists are written before any credential exists.

- Run the review on a staging environment that matches production, after the key ceremony, with the named reviewers.

## Risks and open points

- Reviewer availability sets the schedule; book it when M4 tasks are near done.
- Staging must match production closely (same relay count, limits, CSP, tokens scoped the same) or findings may not transfer; list any differences in `scope.md`.
- Release key holders and the key ceremony (plan README decision) should be done before the review so the signing path can be checked as it will run.
- Open crypto points for Pavol to decide or accept (ADR 0014 follow-ups, also in C-06): who signs the revocation list and how often it is re-signed; the maximum validity `expiresAt − issuedAt` the verifier accepts; an optional torsion-free engine-key check at registration (beyond noble's small-order check on A); an optional pin of Fulcio OID `1.3.6.1.4.1.57264.1.20` (build trigger), since X-03 also allows `workflow_dispatch`. Link codes are 128 bits on purpose (short-lived, single-use, rate-limited); not a finding.
