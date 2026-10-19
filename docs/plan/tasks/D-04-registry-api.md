# D-04. Registry API for relays and the relay's HTTP registry adapter

- **Lane:** D · **Module:** `apps/dashboard` and `apps/relay` (two modules, see Context) · **Milestone:** M3
- **Depends on:** D-03, R-02 · **Unblocks:** D-08, X-05
- **Status:** todo
- **Spec:** Interfaces (draft) 2; Relay and tunnel (Enterprise custom domains); Operations (Dashboard or Cloudflare down); Abuse on our domains (item 8); ADRs: [0005](../../adr/0005-modular-architecture.md)

## Goal

Relays read the engine registry from the dashboard: `GET /internal/v1/engines/{engineId}` serves it, authenticated with a relay key, and the relay gets an HTTP registry adapter with a 5-minute cache and stale-on-error, replacing the static file adapter in deployed environments.

## Context

This task touches two modules because the endpoint and its only client must change together: the dashboard side (endpoint, relay keys) and the relay side (adapter implementing the registry port R-02 defined). Keep them in separate commits; one PR is fine. The apps share only the C-03 schemas from `packages/protocol`, never code.

The relay must not trust the dashboard more than necessary: default hostnames are derived from the engine key and custom hostnames need a claim signed by that key, so a compromised dashboard can deny service but cannot route one engine's hostname to another engine.

## Scope

Dashboard (`apps/dashboard`):

- Migration `0004_relays.sql`: `relays(relay_id TEXT PK, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, revoked_at INTEGER)`. Two rows per relay may be live during rotation.
- `scripts/mint-relay-key.ts` (run locally against an environment with wrangler): creates a relay row, prints the token once.
- `GET /internal/v1/engines/{engineId}`: `Authorization: Bearer <token>` → SHA-256 → lookup of a non-revoked relay, else 401. Path parsed with the protocol `EngineId` schema (400). Unknown engine → 404. Otherwise 200 with the C-03 registry response: `enginePublicKey`, `hostnames` (default hostname plus active custom hostnames with their engine-signed claims, `"ptbk-hostname-v1" | hostname | engineId`), `status: 'active' | 'suspended'`. `Cache-Control: no-store`. Per-relay rate limit (600 per minute).
- The response carries nothing about the owning organization, its users or billing; relays need routing data only. This endpoint is not org-scoped (relays are platform actors), so it reads through a dedicated `RegistryReader` port rather than the org-scoped `EngineStore` methods.
- Custom hostnames come from the `engine_hostnames` table that D-08 adds; until then the list holds only the default hostname. Read it through an `EngineHostnameStore` port so D-08 only adds an adapter and rows.

Relay (`apps/relay`):

- `src/adapters/http-engine-registry.ts` implementing R-02's registry port, with deps `{ fetch, clock, logger, config }`. Config: `REGISTRY_URL`, `REGISTRY_TOKEN`, `REGISTRY_TTL_MS` (300000), `REGISTRY_TIMEOUT_MS` (3000), `REGISTRY_NEGATIVE_TTL_MS` (60000).
- Every response parsed with the C-03 schema. Before caching, the adapter checks that `engineId` equals the protocol derivation of `enginePublicKey` (reject the whole entry otherwise) and verifies every custom hostname claim with the C-01 function, dropping hostnames that fail and logging only the engine ID and the count dropped.
- Cache: fresh for the TTL; on timeout, network error, 5xx, 401/403 or schema failure, serve the stale entry and log `registry-stale`; 404 removes the entry and is negatively cached; concurrent lookups for one engine share one request.
- Connected tunnels are re-checked every TTL: `suspended` or 404 closes the tunnel, changed hostnames update the routing map. If R-03's session manager already does this, reuse it; otherwise add it there.
- Composition root picks the HTTP adapter when `REGISTRY_URL` is set; the static file adapter stays for local dev and e2e until X-05 switches them.

## Out of scope

- Adding and verifying custom hostnames (D-08); suspending engines (I-05).
- Pushing changes to relays faster than the TTL (open point).

## Design notes

- Interface 2 is keyed by engine ID, not hostname. The relay looks up by engine ID when an engine authenticates its tunnel, then routes SNI against the hostnames of connected engines. A browser SNI never triggers a registry call: a default hostname whose engine has no tunnel is closed locally. If R-02's port is hostname-keyed, adapt in the relay's domain layer (parse the engine ID from a default hostname; resolve custom ones through the connected-engine map) and note it in the PR.
- Unbounded stale serving matches the spec ("keeps serving stale entries"); make a maximum stale age configurable with no default limit.
- Relay tokens are secrets: never logged, compared only through their hash.

## Acceptance criteria

- [ ] Dashboard Workers tests: no header, wrong token and revoked relay → 401; malformed engine ID → 400; unknown → 404; active engine → 200 matching the C-03 schema with no org, user or billing fields; suspended engine → `status: "suspended"`; a session cookie alone does not authenticate.
- [ ] Relay adapter tests (injected `fetch` and `Clock`): fresh hit makes no request; expiry refetches; dashboard 500, timeout and invalid JSON serve stale; 404 evicts and negative-caches; key/engine ID mismatch rejected; custom hostname with a bad claim dropped, good one kept; ten concurrent lookups make one request.
- [ ] The shared registry port test suite from R-02 runs against the in-memory, static and HTTP adapters.
- [ ] A relay test shows a connected tunnel closed within one TTL after its entry turns `suspended`.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Exact JSON shape of claims inside `hostnames` is C-03's call; follow it.
- Suspension reaches relays only after the TTL (up to 5 minutes), which meets the "within hours" takedown target. A push or relay admin endpoint for instant cuts is not planned.
- Where relay tokens are stored on hosts is part of I-01 and I-03.
