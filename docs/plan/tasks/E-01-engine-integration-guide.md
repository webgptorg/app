# E-01. Engine integration guide for the engine team

- **Lane:** Engine integration · **Module:** `docs/engine-integration/` · **Milestone:** M2 (pulled forward)
- **Depends on:** C-02, C-03, C-04, C-06
- **Status:** in progress (#29 merged; awaiting maintainer review)
- **Spec:** Interfaces (draft) 1–6, Relay and tunnel, Pairing and identity, Residual risks (2. Engine updates), Security hardening 1, 7, 8, Build plan; ADRs: [0002](../../adr/0002-public-private-split.md), [0003](../../adr/0003-ui-as-signed-bundle.md), [0004](../../adr/0004-mock-engine-and-conformance.md), [0014](../../adr/0014-cryptography.md)

## Goal

`docs/engine-integration/` tells the engine team exactly what the open engine must implement to replace the mock engine: what to build, which contract package exports each message, which conformance checks prove it, and where the mock engine does the same thing.

## Context

The engine team builds in the public `webgptorg/promptbook` repo against our contracts and integrates last (M5). They need lead time, so this guide lands in M2 as soon as the contracts exist, even while parts of the mock engine are still in progress. The guide moves public with the contracts in E-02, so it contains nothing private: no relay internals beyond the tunnel protocol, no dashboard internals beyond the engine-facing endpoints, no infra details, no secrets. The spec stays the source of truth for why; this guide is the how, linked to code.

## Scope

One file per topic, each with: what the engine must do (normative, "must"/"should"), the contract exports to use, a sequence diagram (mermaid) where there is an exchange, failure handling, the conformance check IDs that cover it, and the mock engine file that implements it.

- `README.md`: overview diagram, reading order, contract package names and versions, glossary (engine ID, default and custom hostname, link code, relay, gateway, UI bundle), and how contract changes are proposed (PR, `v2` beside `v1`, never edit `v1`).
- `cryptography.md`: the encodings every engine signature and check uses (ADR 0014): the length-prefixed `signingInput` (contexts, raw-byte parts, `"ptbk-x-v1" | a | b` as notation only), DSSE envelopes and PAE for release and revocation documents (`payload` and `sig` in standard padded base64, `keyid` = base64url(SHA-256(raw public key)); base64url without padding everywhere else). Strict verification: the engine must accept exactly what `@noble/curves@2.4.0` `ed25519.verify(sig, msg, pub, { zip215: false })` accepts (`zip215: false` must be passed; noble's default is `true`): canonical A and R encodings (y < p, no negative zero), S < L, A not of small order, then the cofactored equation. Small- or mixed-order R and mixed-order A are accepted when the equation holds, which libsodium does not do, so an engine using libsodium or another library must reproduce noble's results. `ed25519-vectors.json` from C-01 records noble's actual accept/reject per vector and is the reference the engine must match. Never compare signature bytes, only verify. Random values only from a CSPRNG.
- `identity-and-registration.md`: key generation and storage (`PTBK_DATA_DIR`, 0700), `deriveEngineId`, the registration call (signed over `v`, link code, raw public key, version and mode), `checkRegistrationResponse`, re-registration and errors: registering an already-registered key with a link code from the same organisation while the engine is active is idempotent (200 with the existing engine; the link code is consumed and the engine's `engineVersion` and `mode` are updated from the signed request), from another organisation is 409 `engine-exists` (link code unused), and a suspended or owner-revoked engine gets 403 `engine-suspended`. Engine key handling (normative): create the key file with `O_EXCL` and mode 0600, fsync file and directory before first use, refuse to start if the file or directory is not owned by the engine's UID or is group/world-accessible, import it non-extractable at runtime; use the engine key only through `signingInput` contexts, never for TLS, ACME account keys or anything else. Compromise recovery: there is no in-place rotation (the engine ID is the key's hash), so recovery is a new key and identity, an owner reset and re-registration; the owner can "revoke engine" in the dashboard (step-up; D-06), which suspends it so relays cut its tunnels at the next registry refresh.
- `tunnel-client.md`: dialling every relay in the list over WSS (`HTTPS_PROXY`/`NO_PROXY`, CONNECT), handshake with signed version and feature negotiation (the engine signs its software `version` and the relay's and its own lists from `challenge` and `auth`, encoded exactly as C-02 defines, so nothing in `auth` is unsigned, and closes with `PROTOCOL_ERROR` unless `ready` matches `checkTunnelReady`), verifying the relay's TLS certificate for the relay hostname, `reject` reasons and `TUNNEL_CLOSE_CODE` handling (when to reconnect, when to back off; `rate-limited` arrives as close code 1013), frame handling including ignorable frame types, flow control with `WINDOW`, ping every 25 s, reconnect with exponential backoff and jitter, terminating the browser's TLS inside each stream, custom hostname claims and the DNS the customer must set: a CNAME from the custom hostname to `<engineId>.<engine domain>` (C-03's `expectedCnameTarget`), not to a relay; the relay routes the hostname only when the claim verifies and that CNAME resolves to the engine's default hostname, refuses it for every engine when two connected engines claim it, and apex domains are not supported in v0 (the engine's setup UI and docs must say so), ACME TLS-ALPN-01 through the relay (with an ACME account key separate from the engine key).
- `heartbeat.md`: every 60 s, `buildHeartbeat` and `signHeartbeat` over the exact bytes sent (`signingInput('ptbk-heartbeat-v1', sha256(rawBody))` with the raw 32-byte digest, not its text form), strictly increasing `seq` persisted across restarts, rounding rules, that the security panel shows the last payload verbatim, and that a `stale-ts` answer's `serverTime` is shown there as clock skew.
- `ui-loader.md`: download the `ui` artifact from R2 or a mirror, `verifyRelease` (DSSE envelope, threshold, exact Sigstore identity, log inclusion and trusted time, delay, revocation list freshness and rollback); persist `firstSeenAt` per payload hash the first time a release is seen and pass it in; persist the `issuedAt` of every revocation list accepted and pass it as `lastAcceptedRevocationIssuedAt`; keep the current version when the revocation list is missing, invalid, expired or rolled back; verify against the pinned `trusted_root.json`, SHA-256 of the tarball, unpack into a read-only directory, `verifyManifestFiles`, serve only listed files under `ENGINE_UI_CSP`, keep the previous bundle on any failure; the Sigstore adapter the mock uses: built on `@sigstore/verify@4.1.2` directly (with `@sigstore/bundle@5.0.0` and `@sigstore/protobuf-specs@0.5.2` pinned exactly), never `sigstore.verify()`, whose identity match is an unanchored regex and whose OID compare uses raw DER; exact SAN and decoded-OID comparison, `tlogThreshold: 1`, `ctlogThreshold: 1`, `trustedTime` = the latest verified timestamp.
- `engine-api.md`: the OpenAPI document and route table, problem+json codes, pagination, SSE replies with `Last-Event-ID`, secrets write-only, audit entries per mutation (actor member ID, action, target), step-up routes, and the permission model: `/me` returns explicit permissions, every mutating route requires one and answers 403 `forbidden` without it, and nothing may assume a single user even though v0 has only the owner. Engine requirement (future addition to `GET /audit/verify`, not yet in C-04): the hash chain is complemented by engine-signed checkpoints (`signingInput('ptbk-audit-checkpoint-v1', …)` over the latest `seq` and hash), and `/audit/verify` will report the latest checkpoint, so truncating the chain's tail is detectable.
- `gateway.md`: what the API assumes from the open gateway: `__Host-` session cookie (`Secure`, `HttpOnly`, `SameSite=Strict`), Fetch Metadata rejection of cross-site requests, anonymous access limited to sign-in, setup and public agents, 401 problem+json for anonymous API calls, step-up signalling, CSP and Trusted Types headers for the UI.
- `conformance.md`: running the suite against an engine (CLI flags, env, writing a `ConformanceTarget`, reading the JUnit report), and which suites exist versus planned.
- `mock-engine.md`: the mock engine as reference implementation: how to run it locally, its dev-only control endpoint (never to be copied into the real engine), and a map from each guide section to its source files.
- `checklist.md`: one table, requirement → spec section → contract export → conformance check ID → status, which the engine team can copy into their tracking.

## Out of scope

- Moving or publishing the contracts (E-02). Engine internals the contracts do not touch (agent runtime, storage, updater container mechanics). Writing engine code.

## Design notes

- Link to exports by name and to golden vectors (`ed25519-vectors.json` and the `signingInput` vector from C-01, `vectors.json` from C-02, C-03, C-06); never paste schema definitions, so the guide cannot drift from the code.
- Where a mock engine task is not merged yet, mark the section `Reference implementation: pending M-0x` and leave a checklist row; whoever merges that task updates the section.
- Plain English, short sentences, as in the spec. No marketing.

## Acceptance criteria

- [x] Every interface in the spec (1–6) and every engine-api route group is covered by a section and at least one checklist row.
- [x] Every conformance check ID that exists in `packages/conformance` appears in `checklist.md` (a test or script fails when one is missing).
- [x] `checklist.md` has rows for strict verification against C-01's vectors, signed tunnel negotiation (including `version`), engine key handling, idempotent re-registration, custom hostname CNAME, `firstSeenAt` persistence, and revocation list freshness and rollback.
- [x] A link check over `docs/engine-integration/` passes (relative links only, all targets exist).
- [x] A grep for private hostnames, internal paths beyond `/internal/v1` and secret-like strings finds nothing.
- [ ] Reviewed by the engine team contact (or, until named, by a maintainer), with their questions answered in the guide or listed as open points.
- [x] `bun run check` passes (Prettier on Markdown).
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Who builds the engine side, and when, is an open human decision (plan, [Still needed](../README.md#decisions)); the review criterion depends on it.
- Open contract points must be listed in the README until resolved, so the engine team does not build against guesses: C-02 (`reject` and version/feature negotiation details), C-04 (base path, run control) and C-06 (revocation threshold). Registry lookup, registration proof of possession and the release signing identity are decided and documented as such.
- How conformance obtains a session on a passkey-only engine (C-05) needs an engine-side answer; raise it in `conformance.md`.
- The production ACME client is the engine team's choice (`acme-client@5.4.0`, unmaintained since 2024, is used only in the M-03 Pebble spike); list it as an open point.
- The audit checkpoint format (payload, cadence, where checkpoints are published) is an engine design point; C-04 adds the `checkpoint` field to `GET /audit/verify` in a later change.
