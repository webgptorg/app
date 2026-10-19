# D-04. Registry API for relays and the relay's HTTP registry adapter

- **Lane:** D · **Module:** `apps/dashboard` and `apps/relay` (two modules, see Context) · **Milestone:** M3
- **Depends on:** D-03, R-03
- **Status:** todo
- **Spec:** Interfaces (draft) 2; Relay and tunnel (Enterprise custom domains); Operations (Dashboard or Cloudflare down); Abuse on our domains (item 8); ADRs: [0005](../../adr/0005-modular-architecture.md), [0014](../../adr/0014-cryptography.md)

## Goal

Relays read the engine registry from the dashboard: `GET /internal/v1/engines/{engineId}` serves it, authenticated with a relay key, and the relay gets an HTTP registry adapter, wrapped by R-02's cache (5-minute TTL, stale-on-error for at most 24 h), replacing the static file adapter in deployed environments.

## Context

This task touches two modules because the endpoint and its only client must change together: the dashboard side (endpoint, relay keys) and the relay side (adapter implementing the registry port R-02 defined). Keep them in separate commits; one PR is fine. The apps share only the C-03 schemas from `packages/protocol`, never code.

The relay must not trust the dashboard more than necessary: default hostnames are derived from the engine key and custom hostnames need a claim signed by that key, so a compromised dashboard can deny service but cannot route one engine's hostname to another engine.

## Scope

Dashboard (`apps/dashboard`):

- Table in `src/adapters/db/schema.ts` (drizzle-kit generates the migration). One row per token, not per relay: `relay_id` is not unique, so two live tokens per relay overlap during rotation (ADR 0014):

  ```ts
  export const relayTokens = sqliteTable(
    'relay_tokens',
    {
      id: text('id').primaryKey(),
      relayId: text('relay_id').notNull(),
      tokenHash: text('token_hash').notNull().unique(),
      createdAt: integer('created_at').notNull(),
      expiresAt: integer('expires_at').notNull(),
      lastUsedAt: integer('last_used_at'),
      revokedAt: integer('revoked_at'),
    },
    (t) => [index('relay_tokens_relay_id_idx').on(t.relayId)],
  );
  ```

- Relay token format: `ptbk_rt_` + base64url(32 bytes from `Random`), no padding; the prefix lets secret scanners spot leaks. Only `SHA-256(token)` is stored.
- `scripts/mint-relay-key.ts` (run locally against an environment with wrangler): `--relay <relayId>` inserts a token row (default expiry 365 days) and prints the token once; `--revoke <id>` ends an old token after rotation. Rotation: mint, deploy the new token to the relay (I-01), revoke the old one.
- `GET /internal/v1/engines/{engineId}` in the Hono `/internal` router, bound to the C-03 contract: `Authorization: Bearer <token>` → format check (prefix and 43 base64url characters, else 401 without a query) → SHA-256 → lookup by `token_hash` of a row with `revoked_at` null and `expires_at > now`, else 401 → `last_used_at` updated at most once a minute (`ctx.waitUntil`). Path parsed with the protocol `EngineId` schema (400). Unknown engine → 404. Otherwise 200 with C-03's `RegistryEntry`: `enginePublicKey`, `hostnames` (default hostname plus active custom hostnames), `claims: [{ hostname, sig }]` (one engine-signed claim per custom hostname, over `signingInput('ptbk-hostname-v1', hostname, engineId)`), `status: 'active' | 'suspended'`. `Cache-Control: no-store`. Per-relay rate limit (600 per minute, keyed by `relay_id`).
- The response carries nothing about the owning organization, its users or billing; relays need routing data only. This endpoint is not org-scoped (relays are platform actors), so it reads through a dedicated `RegistryReader` port rather than the org-scoped `EngineStore` methods.
- Custom hostnames come from the `engine_hostnames` table that D-08 adds; until then the list holds only the default hostname. Read it through an `EngineHostnameStore` port so D-08 only adds an adapter and rows.

Relay (`apps/relay`):

- `src/adapters/http-engine-registry.ts`: a plain fetch adapter implementing R-02's `EngineRegistry` port, with deps `{ fetch, logger, config }`. It sends one `GET` with the bearer token and a timeout, parses the body with C-03's `RegistryEntry` schema and maps the result: 200 → `found`, 404 → `not-found`, and timeout, network error, 5xx, 401/403 or schema failure → `unavailable` (logged as `registry.error` with the engine ID and the failure kind only). It holds no cache and verifies no claims.
- The composition root wraps it in R-02's `createCachedRegistry`, which owns freshness (`RELAY_REGISTRY_TTL_S`, 300), stale-on-error up to `maxStaleMs` (`RELAY_REGISTRY_MAX_STALE_S`, 86400), negative caching and request sharing. Do not re-implement any of it here.
- Hostname routing uses C-03's `resolveRoutableHostnames` (through R-02's hostname policy), the single implementation of the default-hostname derivation and claim verification. The entry's `enginePublicKey` must equal the key the engine proved at tunnel auth (R-03); otherwise the tunnel is refused with `auth-failed`.
- Config, added to R-02's `parseRelayConfig` schema: `RELAY_REGISTRY_KIND=http` selects this adapter, with `RELAY_REGISTRY_URL` (dashboard base URL), `RELAY_REGISTRY_TOKEN` (relay key, secret) and `RELAY_REGISTRY_TIMEOUT_MS` (default 3000); the schema requires the three when the kind is `http` and rejects them when it is `static`.
- Connected tunnels are re-checked every TTL: `suspended` or 404 closes the tunnel, changed hostnames update the routing map. If R-03's session manager already does this, reuse it; otherwise add it there.
- The composition root picks the adapter from `RELAY_REGISTRY_KIND`; `static` (with `RELAY_REGISTRY_FILE`) stays for local dev and e2e until X-05 switches them.

## Out of scope

- Adding and verifying custom hostnames (D-08); suspending engines (I-05).
- Pushing changes to relays faster than the TTL (open point).

## Design notes

- Interface 2 is keyed by engine ID, not hostname. The relay looks up by engine ID when an engine authenticates its tunnel, then routes SNI against the hostnames of connected engines. A browser SNI never triggers a registry call: a default hostname whose engine has no tunnel is closed locally.
- Stale entries are served for at most 24 h (R-02's `maxStaleMs`, `RELAY_REGISTRY_MAX_STALE_S`=86400); after that the entry is `unavailable` and the tunnel is refused or closed.
- Relay tokens are secrets: never logged. They are looked up by SHA-256 hash, never compared as plaintext, so lookup timing reveals nothing useful (ADR 0014); log the token row `id` and `relay_id` only.

## Acceptance criteria

- [ ] Dashboard migration is drizzle-kit output and passes D-01's guards; schema allowlist updated.
- [ ] Dashboard Workers tests: no header, malformed token, wrong token, revoked token and expired token → 401; two live tokens for one relay both authenticate, and revoking one leaves the other working; `scripts/mint-relay-key.ts` output matches the token format and the row holds only the hash; malformed engine ID → 400; unknown → 404; active engine → 200 matching the C-03 schema with no org, user or billing fields; suspended engine → `status: "suspended"`; a session cookie alone does not authenticate.
- [ ] Relay adapter tests (injected `fetch`): 200 → `found` with a parsed entry; 404 → `not-found`; dashboard 500, 401, timeout and invalid JSON → `unavailable`; the token is sent and never logged. Through `createCachedRegistry` with a fake `Clock`: fresh hit makes no request; dashboard down serves stale until 24 h, then `unavailable`; ten concurrent lookups make one request. An entry whose key differs from the tunnel's key → `auth-failed`; through `resolveRoutableHostnames`, a custom hostname with a bad claim is dropped and a good one kept.
- [ ] The shared registry port test suite from R-02 runs against the in-memory, static and HTTP adapters.
- [ ] A relay test shows a connected tunnel closed within one TTL after its entry turns `suspended`, and closed or refused once the stale entry passes 24 h during a dashboard outage.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Suspension reaches relays only after the TTL (up to 5 minutes), which meets the "within hours" takedown target. A push or relay admin endpoint for instant cuts is not planned.
- Where relay tokens are stored on hosts is part of I-01 and I-03.
