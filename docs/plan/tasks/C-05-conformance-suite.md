# C-05. Conformance suite v1, run against the mock engine

- **Lane:** Contracts · **Module:** `packages/conformance` (plus one CI job) · **Milestone:** M2
- **Depends on:** C-03, C-04, M-04
- **Status:** todo
- **Spec:** Build plan (Mock engine first, real engine last), Security hardening 7 and 8, What our platform can and cannot do; ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md), [0002](../../adr/0002-public-private-split.md)

## Goal

`@ptbk/conformance` is a runner that checks any engine at a base URL against the engine API contract and reports pass, fail or skip per check. It runs in CI against the mock engine on every PR, and the engine team can run it standalone against their engine.

## Context

ADR 0004: the real engine replaces the mock only by passing this suite. v1 covers the engine API (the contract engine-ui depends on). Tunnel, heartbeat, registration and UI loader suites come later, and the runner must accept them without restructuring. The package moves public with the contracts (E-02), so it may import `@ptbk/protocol` and `@ptbk/engine-api` but nothing private, and its core stays portable (fetch, WebCrypto).

## Scope

- `src/target.ts`: `ConformanceTarget` port: `{ baseUrl: URL; fetch: typeof fetch; session(subject: SessionSubject): Promise<SessionCredential | null> }`, `SessionSubject = { kind: 'owner' } | { kind: 'member', permissions: readonly Permission[] }`, `SessionCredential = { cookie: string } | { bearer: string }`. Each engine implements `session` its own way. Mock engine: `POST /__mock/sessions { subject }` on its dev-only control listener (M-04), with `subject` `{ kind: 'owner' }` or `{ kind: 'member', permissions }`, returns a session cookie for a member with exactly those permissions; the mock target ships in `src/targets/mock-engine.ts`. Real engine: open point for the engine team (see Risks); `null` skips checks that need that subject. Subjects are described by permissions, not role names, because the role-to-permission mapping is engine policy (C-04).
- `src/check.ts`: `ConformanceCheck { id: 'engine-api.secrets.never-returned', suite, title, run(ctx): Promise<CheckOutcome> }`, `CheckOutcome = { kind: 'pass' } | { kind: 'fail', detail } | { kind: 'skip', reason }`. `ctx` holds the target, a seeded `Random`, an `AbortSignal` and a per-run resource tracker for cleanup.
- `src/runner.ts`: `runConformance({ target, suites, filter?, timeoutMs, signal }) → ConformanceReport { startedAt, engineVersion | null, results[] }`; checks run sequentially, each with its own timeout; cleanup runs even after failure.
- `src/report.ts`: JSON and JUnit XML writers (JUnit for CI annotations).
- `src/suites/engine-api/*.ts`, the v1 checks:
  - **Auth:** every route in `ENGINE_API_ROUTES` without credentials returns 401 problem+json and leaks no resource data.
  - **Schemas:** every successful response parses with its strict response schema; every 4xx/5xx is `application/problem+json` with a known `code`.
  - **Input strictness:** an unknown field in a request body returns 400 `validation-failed`; an over-long `limit` and a garbage `cursor` return 400.
  - **Pagination:** create `limit + 3` resources, walk all pages with `limit` 2: no duplicates, no gaps, last `nextCursor` is `null`.
  - **Secrets:** create a secret whose value is a random canary; call every GET route and the SSE stream and search raw response bytes (base64 and hex forms too) for it: never found. Replace, revoke, delete each change metadata as expected.
  - **Agents:** create from a fixture book, appears in list; source update with a stale `baseRevisionId` returns 409; delete hides it, restore brings it back; `validate` on a broken fixture returns at least one `error` diagnostic.
  - **Chat streaming:** posting a message yields `text/event-stream`; events parse; reconnecting with `Last-Event-ID` gives no duplicated `seq`; the final `completed` message equals the stored message.
  - **Audit:** each mutation above appears in `/audit` with `actor.memberId` equal to the acting session's `/me` `memberId`, the expected `action` and `target`; `prevHash` of entry n equals `hash` of entry n−1 within a page.
  - **Permissions:** the owner's `/me` lists every `Permission`. For every non-draft mutating route in `ENGINE_API_ROUTES`, a member holding all permissions except the route's `permission` gets 403 `application/problem+json` with code `forbidden` and the matching `requiredPermission`, and an owner read afterwards shows no state change. A member with only `.read` permissions can call every read route its permissions cover. The denied attempt is audited with outcome `denied`.
  - **Security panel:** `lastHeartbeat.body` parses with the protocol `Heartbeat` schema.
  - **Cross-member:** a second member with the same permissions gets 403 or 404 on resources the engine policy keeps private to the first (skip when the target reports no such resources in v0).
  - **Gateway:** a state-changing request with `Sec-Fetch-Site: cross-site` returns 403.
- `bin/ptbk-conformance.ts` (Node, outside `src/`), bundled to `dist/ptbk-conformance.js` by a `build` script (`bun build --target=node`, no new dependency) because extensionless imports do not run under plain Node type stripping; `bin` in `package.json` points to the bundle, and in development the source runs with `bun` or `tsx`: CLI `--base-url`, `--suite`, `--filter`, `--report json|junit`, `--out`; credentials from a `--target-module` exporting a `ConformanceTarget` (needed for permission checks), or, for owner-only runs, `PTBK_CONFORMANCE_OWNER_COOKIE` (permission checks then skip). Exit code 0 only when nothing failed.
- Crypto check IDs registered now as `skip` (`not-implemented`) in the later suites, so the engine team can track them (ADR 0014): `tunnel.negotiation.downgrade-refused` (acting as relay: a `ready` with a lower version, a missing or an extra feature makes the engine close with `PROTOCOL_ERROR`; the `auth` signature covers both lists from `challenge`), `tunnel.auth.list-encoding` (acting as relay: a `challenge` whose multi-element `protocolVersions` and `features` arrive unsorted, e.g. `[10, 2, 1]` and features that sort differently by byte than by locale, gets an `auth` that C-02's `verifyTunnelAuth` accepts, proving the engine sorts numerically and by byte and comma-joins exactly as C-02 defines), `tunnel.auth.version-signed` (the `auth` signature verifies only over the `version` the engine sent; the same signature checked with any other `version` fails, so an engine that leaves `version` out of `ptbk-tunnel-v1` fails), `ui-loader.signature.strict-ed25519` (releases signed with C-01's `ed25519-vectors.json` cases get exactly the accept/reject recorded there: e.g. non-canonical A or R, S ≥ L and small-order A are refused, while a small- or mixed-order R that satisfies the cofactored equation is accepted, as noble with `zip215: false` does), `ui-loader.dsse.pae-only` (a signature over the raw payload instead of the PAE, a changed payload byte or a wrong `payloadType` is refused), `ui-loader.provenance.exact-identity` (wrong repository, commit, ref or runner is refused), `ui-loader.delay.trusted-time` (a backdated `publishedAt` does not shorten the delay) and `ui-loader.revocations.expired-keeps-current`.
- CI job in `.github/workflows/ci.yml`: start the mock engine with a fixed seed, run the CLI, upload the JUnit report.
- `README.md` for engine teams: install, run, write a target, read the report.

## Out of scope

- Tunnel, heartbeat, registration and UI loader suites (follow-up tasks once M-01, M-05, M-06 exist; register their IDs now as `skip` with reason `not-implemented`). Engine-side test hooks (engine team). E2E browser flows (X-04).

## Design notes

- Extend the portable ESLint block to `packages/conformance/src/**`, allowing only `@ptbk/protocol` and `@ptbk/engine-api` among workspace imports.
- Fixtures (`src/fixtures/`) are synthetic: no real names, keys or tokens. Every resource the suite creates is named with the prefix `conformance-<runId>-` and deleted at the end.
- Check IDs are stable; renaming one is a breaking change for engine teams tracking results.

## Acceptance criteria

- [ ] Self-test: an in-process fake target (`fetch` handler) that is deliberately broken fails the matching check for each defect: leaked secret value, extra response field, missing auth, missing permission check on one mutating route, 403 with a plain-text body, duplicate page item, missing audit entry, audit entry with the wrong `memberId`, wrong problem content type. A correct fake passes everything.
- [ ] The suite passes against the mock engine in CI on every PR; a failing check fails the job.
- [ ] The bundled CLI (declared under `bin` in `package.json`, run with Node 24) works against any URL with only `protocol` and `engine-api` as workspace dependencies, as the README describes; a failing run exits non-zero.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- How the suite gets sessions on the real engine (passkeys only), including members with chosen permissions while v0 has no member features, is an open point for the engine team: a test-only bootstrap behind a flag, scoped API tokens, or WebAuthn virtual authenticators. Agree before E-03; the mock's `/__mock/sessions` is never copied into the real engine.
- The gateway check assumes the gateway runs in front of the API in the tested deployment; for an engine API run without the gateway it must be skippable.
- Suites that act as relay or dashboard (tunnel, heartbeat, registration) need to host servers and are Node-only; keep them under `bin/` or a second entry decided then.
