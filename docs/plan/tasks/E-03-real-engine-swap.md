# E-03. Run conformance and e2e against the real engine

- **Lane:** Engine integration · **Module:** `e2e/`, CI workflows; contract fixes in the public contracts repo · **Milestone:** M5
- **Depends on:** E-02, X-02, X-04, X-05
- **Status:** in progress (feat/e-03-real-engine-local-stack)
- **Spec:** Build plan (Mock engine first, real engine last; Spike acceptance criteria; v0 epics "Mock engine and conformance", "Engine UI"); ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md)

## Goal

The real engine from `webgptorg/promptbook` passes the conformance suite and the full e2e suite (spike, UI flows, dashboard flow) in CI, with no change to the relay, the dashboard or engine-ui beyond fixing real bugs; the mock engine stays as the default test double.

## Context

ADR 0004 promises that swapping in the real engine means pointing the e2e and conformance runs at it and nothing else. This task tests that promise. Gaps found here are either an engine bug (fixed by the engine team), a contract ambiguity (fixed in the public contracts, then in both engines), or a mock engine shortcut (fixed in the mock, because the mock must not do anything the real engine would not).

## Scope

- Engine selection in the e2e harness (X-01): `ENGINE_IMPL=mock|real`. `real` runs the engine's signed Docker image pinned by digest, configured through its documented variables (Interface 6: `PTBK_MODE=tunnel`, relay list, dev CA or Pebble for ACME, `PTBK_UPDATE_POLICY=pinned`), registered against the local dashboard with a link code, and loading the UI bundle through its own loader from the test release.
- Conformance against the real engine: a `ConformanceTarget` for it (session acquisition as agreed in C-05), run with every suite that exists.
- CI: a workflow job running conformance and e2e with `ENGINE_IMPL=real` on PRs that touch contracts, e2e or engine-ui, and nightly; the mock job stays required on every PR. Bumping the pinned image digest is a PR that must pass both.
- A gap log in this repository (`docs/engine-integration/gaps.md`, moving to the public repository only when a human decides so): each failing check with its cause class (engine bug, contract ambiguity, mock shortcut, our bug) and owner.
- Repository boundary: agents work only in `webgptorg/app`. They never push to, open pull requests in or file issues on `webgptorg/promptbook` or any other repository; engine bugs from the gap log are handed to the engine team by a human.
- Fixes on our side: mock engine behaviour that the real engine shows to be wrong or too lenient; contract clarifications via a contract release and version bump (E-02 process).
- UI releases the real engine can verify: re-sign the dev and e2e stacks' UI test releases the way C-10's suite does (real Sigstore-format bundles under an ephemeral trust root, delivered through `PTBK_CONFORMANCE_TRUST_FILE`), so the real engine's conformance build installs them. The mock keeps accepting them. Today they carry test attestations that only the mock's fake verifier accepts.
- Decouple the harness from mock internals (E-04 found these): the `identity` and `register --link` JSON that `init`, `dev:link` and the dashboard fixtures parse; waits on the mock's log event names (`tunnel.ready`, `acme.*`); the `/__spike/` routes behind `engine-probe` and the spike, ACME and capture tests; the engine key path that the relay key-scan test reads; and the `/__mock/` control listener for sessions and UI checks. Replace them with what a real engine shows (its API, its security panel, the relays' and dashboard's view) or with commands the engine documents, and tag what has no replacement `@mock-only`.
- Re-run the spike acceptance criteria (X-02 network tests: NAT, 443-only, CONNECT proxy, TLS-inspecting proxy, relay failover, packet capture) with the real engine.

## Out of scope

- Implementing engine features (engine team). Production rollout of real engines, migration of existing engines (spec, Moving existing deployments).

## Design notes

- The e2e tests must not branch on `ENGINE_IMPL` except in fixtures (startup, credentials, seed data). A test that needs a mock-only capability (fault injection, dev control endpoint) is tagged `@mock-only` and skipped for `real`, with the reason in the tag; keep that list short and reviewed.
- Seed data differs between engines; tests create what they need through the engine API instead of relying on mock seeds when running against `real`.
- The real engine image is verified before use (signature and digest), the same way customers install it.

## Acceptance criteria

- [ ] Conformance: every check passes against the real engine, or is a `skip` with a reason agreed with the engine team and listed in the gap log.
- [ ] E2E: spike tests (X-01, X-02, M-03 ACME through the relay), UI flows (X-04, including zero CSP violations and the loader refusing a tampered and a revoked bundle) and the dashboard flow (X-05) pass with `ENGINE_IMPL=real`.
- [ ] No change in `apps/relay`, `apps/dashboard` or `apps/engine-ui` made only to accommodate the real engine; any change there is a bug fix with a test that also runs against the mock.
- [ ] The mock engine still passes the full suites; every mock behaviour changed here has a conformance check that catches the old behaviour.
- [ ] `@mock-only` tests are listed in the e2e README with reasons.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Blocked on a human decision: who builds the engine side and when (plan, [Still needed](../README.md#decisions)).
- CSP or streaming differences between the real engine and the mock may surface here first.
- Running the real engine in CI needs its image to be publicly pullable and its ACME and update endpoints configurable for tests; confirm with the engine team early.
