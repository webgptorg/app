# R-02. Relay skeleton: config, ports, static registry adapter

- **Lane:** Relay · **Module:** `apps/relay` · **Milestone:** M1
- **Depends on:** C-01, C-03
- **Status:** todo
- **Spec:** Relay and tunnel; Interfaces (draft) 2; Metadata we still see; Hosting and stack; ADRs: [0001](../../adr/0001-bun-workspaces-monorepo.md), [0005](../../adr/0005-modular-architecture.md)

## Goal

`apps/relay` becomes a runnable Node 24 process with a typed config, the ports every later relay task needs, a cached registry with stale-on-error, a static-file registry adapter for local development and e2e, and a production build.

## Context

R-03 (tunnel endpoint) and R-04 (browser listener) plug into this skeleton. The registry is the relay's only external dependency: in M1 it is a JSON file, from M3 it is the dashboard (D-04 adds a plain `fetch` adapter behind the same port, wrapped by this task's `createCachedRegistry`, so caching and stale-on-error exist once). The relay looks engines up by engine ID at tunnel auth only; there is no lookup by hostname. The relay is small (spec estimate about 1,000 lines), so keep the structure light but strict.

## Scope

- `src/domain/clock.ts` (`Clock { nowMs(): number; setTimeout(fn, ms): () => void }`), `src/domain/random.ts` (`Random { bytes(n): Uint8Array }`), `src/domain/logger.ts` (`Logger` with `info/warn/error(event: string, fields: LogFields)`, where `LogFields` allows only string, number and boolean values).
- `src/domain/engine-registry.ts`: port `EngineRegistry { lookup(engineId: EngineId, signal: AbortSignal): Promise<RegistryLookup> }` with `RegistryLookup = { kind: 'found'; entry: RegistryEntry } | { kind: 'not-found' } | { kind: 'unavailable' }`. `RegistryEntry` is C-03's type (`{ enginePublicKey, hostnames, claims: [{ hostname, sig }], status }`); no local copy.
- `src/domain/cached-registry.ts`: `createCachedRegistry({ inner, clock, ttlMs, maxStaleMs, negativeTtlMs, lookupTimeoutMs })` implementing `EngineRegistry`. Fresh entries come from cache. Expired entries are refetched; on `unavailable`, timeout or a thrown error the stale entry is returned and a `registry.stale` event logged, but only while it is younger than `maxStaleMs` (`RELAY_REGISTRY_MAX_STALE_S`, default 86,400: decided 2026-10-19). Older entries count as `unavailable`, so a suspension takes effect within 24 hours even during a dashboard outage. `not-found` is cached for `negativeTtlMs` (default 30 s) so a newly registered engine is not blocked for 5 minutes. `lookupTimeoutMs` comes from `RELAY_REGISTRY_TIMEOUT_MS` (default 3000). Concurrent lookups for one engine share one fetch. Every adapter, including D-04's HTTP one, is wrapped by this; adapters themselves never cache.
- `src/domain/hostname-policy.ts`: `routableHostnames(engineId, entry, engineDomain, logger): readonly Hostname[]`, a thin wrapper around C-03's `resolveRoutableHostnames` (the single implementation of claim verification: default hostname without a claim, every other hostname only with a valid `ptbk-hostname-v1` claim). It logs `hostname.claim-invalid` with the engine ID and the number dropped, never the hostnames. No claim logic is written in the relay.
- Adapters: `system-clock.ts`, `fake-clock.ts`, `node-random.ts`, `json-logger.ts` (one JSON line per event on stdout), `in-memory-registry.ts`, `static-file-registry.ts` (reads a JSON file validated by a strict zod schema: `{ v: 1, engines: [{ engineId, enginePublicKey, hostnames, claims, status }] }`, each entry minus `engineId` being C-03's `RegistryEntry`; reloads on `SIGHUP`, keeping the old contents if the new file is invalid).
- `src/app/config.ts`: `parseRelayConfig(env: Record<string, string | undefined>): RelayConfig`, strict zod, frozen. Fields: `RELAY_HOSTNAME` (also the `relayId` in tunnel challenges, C-02), `RELAY_LISTEN_HOST` (default `0.0.0.0`), `RELAY_LISTEN_PORT` (default 443, `0` allowed for tests), `RELAY_ENGINE_DOMAIN`, `RELAY_TLS_CERT_FILE`, `RELAY_TLS_KEY_FILE`, `RELAY_REGISTRY_KIND` (`static` | `http`), `RELAY_REGISTRY_FILE` (required for `static`), `RELAY_REGISTRY_URL` and `RELAY_REGISTRY_TOKEN` (required for `http`), `RELAY_REGISTRY_TIMEOUT_MS` (default 3000), `RELAY_REGISTRY_TTL_S` (default 300), `RELAY_REGISTRY_MAX_STALE_S` (default 86400), `LOG_LEVEL`. The schema is a discriminated union on the kind, so `http` fields are validated now and D-04 only adds the adapter and its wiring; until then the composition root refuses `http` with a clear error. R-03 and R-04 add their limits to the same schema.
- `src/app/start-relay.ts` (composition root returning `{ close(): Promise<void> }`), `src/main.ts` (parses env, starts, handles `SIGTERM`/`SIGINT` with graceful close).
- Scripts in `apps/relay/package.json`: `dev` (tsx 4.x watch), `build`, `start` (`node dist/main.mjs`). `apps/relay/README.md` lists the env vars and the registry file format (X-01 generates that file).

## Out of scope

- Listeners, TLS, tunnels (R-03, R-04). HTTP registry adapter and relay authentication to the dashboard (D-04). Metrics export (I-04).

## Design notes

- Production build: bundle `src/main.ts` and its workspace dependencies into one ESM file with **tsdown 0.23.x** (Rolldown), target `node24`, sourcemaps on, no minification. Node's built-in type stripping cannot run this code directly: imports have no `.ts` extension (`moduleResolution: Bundler`) and `@ptbk/protocol` exports raw `.ts` from `node_modules`. If tsdown fails a criterion below, use esbuild and say why in the PR. Criteria: single output file plus sourcemap, `node dist/main.mjs` starts with no `node_modules` present except runtime dependencies left external (if any), no install scripts needed, no Bun APIs.
- Config is the only reader of `process.env`. File secrets (TLS key) are paths; `RELAY_REGISTRY_TOKEN` is the one secret passed as a value, and it is never logged or included in config error messages.
- If the relay gets lint rules (for example, `src/domain/` may not import `node:*` or `ws`), build the `no-restricted-imports` block with the `restrictImports(...)` helper in `eslint.config.js`, so the base bans and domain-purity rules are kept.
- Log events are short names (`relay.started`, `registry.stale`); never log hostnames of browser connections, keys or file contents.

## Acceptance criteria

- [ ] Shared adapter test suite for `EngineRegistry` runs against `in-memory-registry` and `static-file-registry`.
- [ ] `cached-registry` tests with `fake-clock`: hit within TTL makes no inner call; expiry refetches; inner `unavailable`, timeout and throw each return the stale entry; no stale entry plus failure returns `unavailable`; a stale entry older than 24 h plus failure returns `unavailable`; `not-found` cached for 30 s only; ten concurrent lookups make one inner call; an aborted signal stops waiting.
- [ ] `hostname-policy` tests: a valid custom claim is kept and an invalid one dropped through C-03's `resolveRoutableHostnames`; the drop is logged with engine ID and count only (claim edge cases are C-03's tests).
- [ ] Config tests: missing required field, unknown `RELAY_REGISTRY_KIND`, `http` without `RELAY_REGISTRY_URL` or `RELAY_REGISTRY_TOKEN`, non-numeric port and port out of range all fail with a readable error that never contains the token.
- [ ] Static registry file with an unknown field is rejected; a reload with an invalid file keeps the previous entries.
- [ ] `bun run --filter @ptbk/relay build` produces `dist/main.mjs`, and `node dist/main.mjs` with a valid env logs `relay.started` and exits cleanly on `SIGTERM`.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- The 24 h stale window trades availability during a dashboard outage against how long a suspension can be ignored. Revisit with I-05 if takedowns must be faster.
