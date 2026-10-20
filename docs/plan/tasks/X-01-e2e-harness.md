# X-01. E2E harness: compose stack, Playwright, first browser test

- **Lane:** X · **Module:** `e2e/` (plus root `package.json` workspaces and `.github/workflows/ci.yml`) · **Milestone:** M1
- **Depends on:** R-04, M-02
- **Status:** todo
- **Spec:** Relay and tunnel, Interfaces (3 tunnel protocol), Build plan (Spike acceptance criteria); ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md)

## Goal

`bun run --filter @ptbk/e2e e2e` brings up two relays, the mock engine and a dev CA in Docker Compose, and Playwright proves that a real browser loads a page through a relay, that SSE and WebSocket work through the passthrough, and that the browser sees the engine's certificate, not the relay's.

## Context

From this task on, every PR must keep the e2e suite green (plan, principle 5). The spike criteria in X-02, the UI flows in X-04 and the dashboard flow in X-05 all extend this harness, so its fixtures and topology matter more than its first tests. The relay never decrypts engine traffic; these tests are the first executable evidence of that.

## Scope

- `e2e/` workspace `@ptbk/e2e`: add `"e2e"` to root `workspaces`. Scripts: `test` (Vitest unit tests for harness helpers only, so the `check` job never needs Docker), `e2e` (up, run, down), `e2e:up`, `e2e:down`, `e2e:logs`. Dev dependency `@playwright/test` 1.64.
- Layout:
  ```
  e2e/
    compose.yaml            base stack
    docker/                 relay.Dockerfile, mock-engine.Dockerfile, playwright.Dockerfile, init.Dockerfile
    init/                   generate.ts: dev CA, relay certs, engine key and cert, static registry
    coredns/Corefile
    playwright.config.ts
    src/fixtures.ts         stack info, cert helpers, compose control, request and CSP collectors
    src/compose.ts          stop/start/kill/restart a service, read service logs
    tests/spike/            first tests
  ```
- Compose services on one network with a fixed subnet:
  - `init` (one-shot): generates a fresh dev CA, TLS certs for `relay-a.ptbk.test` and `relay-b.ptbk.test`, an Ed25519 engine key, the engine certificate for `<engineId>.engine.test` signed by the dev CA, and the static registry file for R-02's adapter, into a shared volume. Nothing generated is committed.
  - `relay-a`, `relay-b`: built from `apps/relay`, static IPs, healthcheck on the relay's own hostname.
  - `mock-engine`: built from `apps/mock-engine`, dials both relays, uses the generated key and cert, trusts the dev CA for the relay connections; healthcheck reports both tunnels ready.
  - `dns`: CoreDNS (image pinned by digest) answering `relay-a/b.ptbk.test` and returning both relay IPs for `*.engine.test`.
  - `playwright`: the official Playwright 1.64 image (pinned by digest) plus `libnss3-tools`; its entrypoint imports the dev CA into the NSS database so Chromium trusts it; uses `dns` as resolver.
- `e2e` script: `docker compose up --build --wait`, then `docker compose run --rm playwright`, always `docker compose logs` to `e2e/test-results/` on failure, then `down -v`.
- Fixtures (`src/fixtures.ts`): `engineHost`, `engineUrl`, `engineCertSha256` (read from the shared volume), `relayHosts`, `compose` (from `src/compose.ts`), `peerCertificateSha256(page)` via CDP `Network.getCertificate`, `requestLog` (every request URL, for "no foreign origin" assertions), `cspViolations` (collects `securitypolicyviolation` through `addInitScript`).
- First tests in `tests/spike/`:
  1. `https://<engineId>.engine.test/` returns 200 with the mock engine's spike page (M-02).
  2. The peer certificate's SHA-256 equals the engine certificate, its subject is the engine hostname, and it differs from both relay certificates (`response.securityDetails()` plus the CDP fingerprint).
  3. SSE: the spike SSE endpoint delivers 20 ordered events to an `EventSource` in the page.
  4. WebSocket: 20 echo round trips, including a 256 KiB binary message.
  5. Negative: `https://unknown.engine.test/` fails to connect (the relay closes unknown SNI); `https://relay-a.ptbk.test/` serves the relay's certificate and no engine content.
- CI: a new `e2e` job in `ci.yml`, separate from `check`: `ubuntu-24.04`, SHA-pinned actions, `permissions: contents: read`, `persist-credentials: false`, no caches (no `actions/cache`, no Buildx cache), timeout 30 min, uploads `e2e/test-results/` with a SHA-pinned `actions/upload-artifact` on failure.

## Out of scope

- NAT, firewall, proxy, failover and packet-capture tests (X-02). ACME through the relay (M-03).
- UI and dashboard flows (X-04, X-05). Load tests (R-05).

## Design notes

- Test domains: `ptbk.test` stands in for our domain and `engine.test` for the separate engine domain (`.test` is reserved, RFC 6761).
- Playwright runs inside the compose network so the browser resolves names like a real client, including two A records for one engine hostname (needed by X-02's failover test). For local debugging on the host, document `--host-resolver-rules` mapping `*.engine.test` to one relay's published port.
- Dockerfiles install with `bun install --frozen-lockfile` and run on Node 24, matching production. Base images pinned by digest.
- No sleeps: wait on healthchecks and `expect.poll`.
- Keep the stack configurable through compose overlays (`compose.<scenario>.yaml`) so X-02, X-04 and X-05 add services without editing the base file much.
- Engine certificate (2026-10-20, after M-02): the mock engine issues its own leaf certificates from the dev CA (`MOCK_DEV_CA_CERT_FILE`, `MOCK_DEV_CA_KEY_FILE`), so `init` generates only the CA, not the engine certificate, and `engineCertSha256` comes from the TLS peer. Any CA `init` generates must carry the constraints in the mock engine README (critical name constraints permitting the engine domain plus `MOCK_DEV_CA_DOMAINS` and excluding every IP range, `pathLen 0`, key usage `keyCertSign` and `cRLSign` only), with a key file not readable by group or others, or the mock engine refuses to start.

## Acceptance criteria

- [ ] `bun run --filter @ptbk/e2e e2e` passes locally on Docker or OrbStack from a clean checkout, and leaves no containers or volumes behind.
- [ ] All five tests above pass in the CI `e2e` job; the job fails if any does.
- [ ] Breaking the trust setup (e.g. engine cert from a different CA) makes test 2 fail, verified once and noted in the PR.
- [ ] `bun run check` passes without Docker (the `test` script runs only helper unit tests).
- [ ] [development.md](../../development.md) documents how to run, debug and read e2e logs; [architecture.md](../../architecture.md) mentions `e2e/`.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- M-02 must let the mock engine take its key and certificate from files and expose readiness for each tunnel; agree the config with the M lane.
- R-02's static registry format and the relay's own-certificate config must be file-based; agree with the R lane.
- Runner time: building images without cache may approach the timeout; if so, prebuild in one step and reuse within the job, still without cross-run caches.
