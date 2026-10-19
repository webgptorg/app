# E-01. Engine integration guide for the engine team

- **Lane:** Engine integration · **Module:** `docs/engine-integration/` · **Milestone:** M2 (pulled forward)
- **Depends on:** C-02, C-03, C-04, C-06
- **Status:** todo
- **Spec:** Interfaces (draft) 1–6, Relay and tunnel, Pairing and identity, Residual risks (2. Engine updates), Security hardening 1, 7, 8, Build plan; ADRs: [0002](../../adr/0002-public-private-split.md), [0003](../../adr/0003-ui-as-signed-bundle.md), [0004](../../adr/0004-mock-engine-and-conformance.md)

## Goal

`docs/engine-integration/` tells the engine team exactly what the open engine must implement to replace the mock engine: what to build, which contract package exports each message, which conformance checks prove it, and where the mock engine does the same thing.

## Context

The engine team builds in the public `webgptorg/promptbook` repo against our contracts and integrates last (M5). They need lead time, so this guide lands in M2 as soon as the contracts exist, even while parts of the mock engine are still in progress. The guide moves public with the contracts in E-02, so it contains nothing private: no relay internals beyond the tunnel protocol, no dashboard internals beyond the engine-facing endpoints, no infra details, no secrets. The spec stays the source of truth for why; this guide is the how, linked to code.

## Scope

One file per topic, each with: what the engine must do (normative, "must"/"should"), the contract exports to use, a sequence diagram (mermaid) where there is an exchange, failure handling, the conformance check IDs that cover it, and the mock engine file that implements it.

- `README.md`: overview diagram, reading order, contract package names and versions, glossary (engine ID, default and custom hostname, link code, relay, gateway, UI bundle), and how contract changes are proposed (PR, `v2` beside `v1`, never edit `v1`).
- `identity-and-registration.md`: key generation and storage (`PTBK_DATA_DIR`, 0700), `deriveEngineId`, the registration call, `checkRegistrationResponse`, re-registration and errors.
- `tunnel-client.md`: dialling every relay in the list over WSS (`HTTPS_PROXY`/`NO_PROXY`, CONNECT), handshake with version and feature negotiation, `reject` reasons and `TUNNEL_CLOSE_CODE` handling (when to reconnect, when to back off), frame handling including ignorable frame types, flow control with `WINDOW`, ping every 25 s, reconnect with exponential backoff and jitter, terminating the browser's TLS inside each stream, custom hostname claims, ACME TLS-ALPN-01 through the relay.
- `heartbeat.md`: every 60 s, `buildHeartbeat` and `signHeartbeat` over the exact bytes sent, strictly increasing `seq` persisted across restarts, rounding rules, and that the security panel shows the last payload verbatim.
- `ui-loader.md`: download the `ui` artifact from R2 or a mirror, `verifyRelease` (threshold, log inclusion, delay, revocation), SHA-256 of the tarball, unpack into a read-only directory, `verifyManifestFiles`, serve only listed files under `ENGINE_UI_CSP`, keep the previous bundle on any failure; the Sigstore adapter the mock uses.
- `engine-api.md`: the OpenAPI document and route table, problem+json codes, pagination, SSE replies with `Last-Event-ID`, secrets write-only, audit entries per mutation (actor member ID, action, target), step-up routes, and the permission model: `/me` returns explicit permissions, every mutating route requires one and answers 403 `forbidden` without it, and nothing may assume a single user even though v0 has only the owner.
- `gateway.md`: what the API assumes from the open gateway: `__Host-` session cookie (`Secure`, `HttpOnly`, `SameSite=Strict`), Fetch Metadata rejection of cross-site requests, anonymous access limited to sign-in, setup and public agents, 401 problem+json for anonymous API calls, step-up signalling, CSP and Trusted Types headers for the UI.
- `conformance.md`: running the suite against an engine (CLI flags, env, writing a `ConformanceTarget`, reading the JUnit report), and which suites exist versus planned.
- `mock-engine.md`: the mock engine as reference implementation: how to run it locally, its dev-only control endpoint (never to be copied into the real engine), and a map from each guide section to its source files.
- `checklist.md`: one table, requirement → spec section → contract export → conformance check ID → status, which the engine team can copy into their tracking.

## Out of scope

- Moving or publishing the contracts (E-02). Engine internals the contracts do not touch (agent runtime, storage, updater container mechanics). Writing engine code.

## Design notes

- Link to exports by name and to golden vectors (`vectors.json` from C-02, C-03, C-06); never paste schema definitions, so the guide cannot drift from the code.
- Where a mock engine task is not merged yet, mark the section `Reference implementation: pending M-0x` and leave a checklist row; whoever merges that task updates the section.
- Plain English, short sentences, as in the spec. No marketing.

## Acceptance criteria

- [ ] Every interface in the spec (1–6) and every engine-api route group is covered by a section and at least one checklist row.
- [ ] Every conformance check ID that exists in `packages/conformance` appears in `checklist.md` (a test or script fails when one is missing).
- [ ] A link check over `docs/engine-integration/` passes (relative links only, all targets exist).
- [ ] A grep for private hostnames, internal paths beyond `/internal/v1` and secret-like strings finds nothing.
- [ ] Reviewed by the engine team contact (or, until named, by a maintainer), with their questions answered in the guide or listed as open points.
- [ ] `bun run check` passes (Prettier on Markdown).
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Who builds the engine side, and when, is an open human decision (plan, [Still needed](../README.md#decisions)); the review criterion depends on it.
- Open contract points must be listed in the README until resolved, so the engine team does not build against guesses: C-02 (`reject` and version/feature negotiation details), C-04 (base path, run control) and C-06 (revocation threshold). Registry lookup, registration proof of possession and the release signing identity are decided and documented as such.
- How conformance obtains a session on a passkey-only engine (C-05) needs an engine-side answer; raise it in `conformance.md`.
