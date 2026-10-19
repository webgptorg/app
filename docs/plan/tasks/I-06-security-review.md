# I-06. Internal security review gate

- **Lane:** I · **Module:** `docs/security-review/` · **Milestone:** M4
- **Depends on:** I-01, I-02, I-03, I-04, I-05, X-04, X-05
- **Status:** todo
- **Spec:** Build plan (Gate to v0 release); Security goals and threat model; Residual risks; What our platform can and cannot do; Metadata we still see; Security hardening item 10; docs/security.md

## Goal

The v0 release has passed the internal review gate: a threat model walkthrough, a pen test by David, a cryptography and key-handling review of the protocol and relay by Pavol, and an onboarding review by Anka, with every finding tracked and the blocking ones fixed and re-tested.

## Context

The spec makes this review the gate between v0 and release; an external audit comes later, before general availability. The reviewers are people, not agents. The coding agent's job is to prepare everything so the reviewers spend their time on breaking things, then to track and fix findings. This repo covers our side (relay, dashboard, engine-ui, release pipeline); the engine's own review happens in the public repo, but the boundary (contracts, conformance) is in scope here.

## Scope

- `docs/security-review/v0/threat-model.md`: each attacker from the spec's table and each guarantee in docs/security.md mapped to the control that enforces it, the test that proves it (file path or e2e name) and the residual risk. Include the organization model (ADR 0006), dashboard recovery and its 72-hour cooldown, and the release pipeline.
- `docs/security-review/v0/scope.md`: environments (staging only, matching production config), accounts and test engines provided, rules of engagement, out-of-scope items, contact during testing.
- Checklists, one file per reviewer:
  - **Pen test (David):** dashboard auth, sessions, CSRF, recovery flow and enumeration, org isolation (IDOR across orgs), admin step-up, registration, heartbeat replay and forgery, registry API auth, Stripe webhook, rate limits; relay SNI parsing (malformed and fragmented ClientHello), unknown SNI handling, tunnel auth, fairness limits, resource exhaustion; host exposure (ports, SSH).
  - **Crypto and keys (Pavol):** engine ID derivation and base32 encoding; Ed25519 usage and signature verification paths; domain-separation contexts (`ptbk-tunnel-v1`, `ptbk-hostname-v1`, `ptbk-register-v1`, `ptbk-release-v1`, `ptbk-revocation-v1`, `ptbk-heartbeat-v1`) and the unambiguity of the `|` concatenation; challenge nonce generation and freshness; relay checks that the engine ID matches the key from the registry; the registration proof of possession (`ptbk-register-v1|…`, C-03/D-03); token generation, hashing and constant-time comparisons; relay TLS key handling; release signing, cosign identity checks and the UI bundle verification inputs.
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

## Risks and open points

- Reviewer availability sets the schedule; book it when M4 tasks are near done.
- Staging must match production closely (same relay count, limits, CSP, tokens scoped the same) or findings may not transfer; list any differences in `scope.md`.
- Release key holders and the key ceremony (plan README decision) should be done before the review so the signing path can be checked as it will run.
