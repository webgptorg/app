# R-02. Relay skeleton: config, ports, static registry adapter

- **Lane:** Relay · **Module:** `apps/relay` · **Milestone:** M1
- **Depends on:** C-01 · **Unblocks:** R-03, D-04
- **Status:** todo
- **Spec:** Relay and tunnel; Interfaces (draft) 2; Metadata we still see; Hosting and stack; ADRs: [0001](../../adr/0001-bun-workspaces-monorepo.md), [0005](../../adr/0005-modular-architecture.md)

## Goal

`apps/relay` becomes a runnable Node 24 process with a typed config, the ports every later relay task needs, a cached registry with stale-on-error, a static-file registry adapter for local development and e2e, and a production build.

## Context

R-03 (tunnel endpoint) and R-04 (browser listener) plug into this skeleton. The registry is the relay's only external dependency: in M1 it is a JSON file, from M3 it is the dashboard (D-04 adds the HTTP adapter behind the same port). The relay is small (spec estimate about 1,000 lines), so keep the structure light but strict.

## Scope

- `src/domain/clock.ts` (`Clock { nowMs(): number; setTimeout(fn, ms): () => void }`), `src/domain/random.ts` (`Random { bytes(n): Uint8Array }`), `src/domain/logger.ts` (`Logger` with `info/warn/error(event: string, fields: LogFields)`, where `LogFields` allows only string, number and boolean values).
- `src/domain/engine-registry.ts`: port `EngineRegistry { lookup(engineId: EngineId, signal: AbortSignal): Promise<RegistryLookup> }` with `RegistryLookup = { kind: 'found'; entry: RegistryEntry } | { kind: 'not-found' } | { kind: 'unavailable' }`. `RegistryEntry` uses the C-03 registry lookup schema types; if C-03 has not merged, define the type from Interfaces 2 locally and leave a note to switch.
- `src/domain/cached-registry.ts`: `createCachedRegistry({ inner, clock, ttlMs, negativeTtlMs, lookupTimeoutMs })` implementing `EngineRegistry`. Fresh entries come from cache. Expired entries are refetched; on `unavailable`, timeout or a thrown error the stale entry is returned and a `registry.stale` event logged. `not-found` is cached for `negativeTtlMs` (default 30 s) so a newly registered engine is not blocked for 5 minutes. Concurrent lookups for one engine share one fetch.
- `src/domain/hostname-policy.ts`: `verifiedHostnames(entry, engineDomain): Promise<readonly Hostname[]>`. The default hostname `<engineId>.<engineDomain>` is accepted without a claim; every other hostname needs a valid engine-signed claim (`"ptbk-hostname-v1" | hostname | engineId`, verified with C-01). Invalid claims are dropped and logged (`hostname.claim-invalid`, engine ID only).
- Adapters: `system-clock.ts`, `fake-clock.ts`, `node-random.ts`, `json-logger.ts` (one JSON line per event on stdout), `in-memory-registry.ts`, `static-file-registry.ts` (reads a JSON file validated by a strict zod schema: `{ v: 1, engines: [{ engineId, enginePublicKey, hostnames, status }] }`; reloads on `SIGHUP`, keeping the old contents if the new file is invalid).
- `src/app/config.ts`: `parseRelayConfig(env: Record<string, string | undefined>): RelayConfig`, strict zod, frozen. Fields: `RELAY_HOSTNAME` (also the `relayId` in tunnel challenges, C-02), `RELAY_LISTEN_HOST` (default `0.0.0.0`), `RELAY_LISTEN_PORT` (default 443, `0` allowed for tests), `RELAY_ENGINE_DOMAIN`, `RELAY_TLS_CERT_FILE`, `RELAY_TLS_KEY_FILE`, `RELAY_REGISTRY_KIND` (`static` now; D-04 adds `http`), `RELAY_REGISTRY_FILE`, `RELAY_REGISTRY_TTL_S` (default 300), `LOG_LEVEL`. R-03 and R-04 add their limits to the same schema.
- `src/app/start-relay.ts` (composition root returning `{ close(): Promise<void> }`), `src/main.ts` (parses env, starts, handles `SIGTERM`/`SIGINT` with graceful close).
- Scripts in `apps/relay/package.json`: `dev` (tsx 4.x watch), `build`, `start` (`node dist/main.mjs`). `apps/relay/README.md` lists the env vars and the registry file format (X-01 generates that file).

## Out of scope

- Listeners, TLS, tunnels (R-03, R-04). HTTP registry adapter and relay authentication to the dashboard (D-04). Metrics export (I-04).

## Design notes

- Production build: bundle `src/main.ts` and its workspace dependencies into one ESM file with **tsdown 0.23.x** (Rolldown), target `node24`, sourcemaps on, no minification. Node's built-in type stripping cannot run this code directly: imports have no `.ts` extension (`moduleResolution: Bundler`) and `@ptbk/protocol` exports raw `.ts` from `node_modules`. If tsdown fails a criterion below, use esbuild and say why in the PR. Criteria: single output file plus sourcemap, `node dist/main.mjs` starts with no `node_modules` present except runtime dependencies left external (if any), no install scripts needed, no Bun APIs.
- Config is the only reader of `process.env`. Secrets (TLS key) are paths, never values.
- Log events are short names (`relay.started`, `registry.stale`); never log hostnames of browser connections, keys or file contents.

## Acceptance criteria

- [ ] Shared adapter test suite for `EngineRegistry` runs against `in-memory-registry` and `static-file-registry`.
- [ ] `cached-registry` tests with `fake-clock`: hit within TTL makes no inner call; expiry refetches; inner `unavailable`, timeout and throw each return the stale entry; no stale entry plus failure returns `unavailable`; `not-found` cached for 30 s only; ten concurrent lookups make one inner call; an aborted signal stops waiting.
- [ ] `hostname-policy` tests: default hostname accepted; custom hostname with valid claim accepted; claim signed by another key, claim for another engine ID, claim for another hostname, and a default-looking hostname under a different domain are all dropped.
- [ ] Config tests: missing required field, unknown `RELAY_REGISTRY_KIND`, non-numeric port and port out of range all fail with a readable error.
- [ ] Static registry file with an unknown field is rejected; a reload with an invalid file keeps the previous entries.
- [ ] `bun run --filter @ptbk/relay build` produces `dist/main.mjs`, and `node dist/main.mjs` with a valid env logs `relay.started` and exits cleanly on `SIGTERM`.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Stale-on-error has no maximum age in the spec. A suspended engine therefore keeps routing during a dashboard outage. Proposal: no limit in v0, revisit in I-05. Flag it, don't add a limit silently.
