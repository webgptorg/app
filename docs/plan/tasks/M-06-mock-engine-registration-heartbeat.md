# M-06. Mock engine registration and heartbeat client

- **Lane:** Mock engine · **Module:** `apps/mock-engine` · **Milestone:** M3
- **Depends on:** C-03, M-01 · **Unblocks:** X-05
- **Status:** todo
- **Spec:** Interfaces (draft) 1, 4 and 6; What our platform can and cannot do (Heartbeat); Pairing and identity (First setup); Metadata we still see; ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md)

## Goal

The mock engine registers with the dashboard using a one-time link code, adopts the engine ID, hostname and relay list it gets back, and sends a signed, numbers-only heartbeat every 60 seconds with a persisted, strictly increasing `seq`.

## Context

This is the engine's only conversation with our platform: one registration, then a one-way heartbeat. The dashboard side is D-03 (registration) and D-05 (heartbeat ingest); the schemas and signature helpers are C-03's. The heartbeat must carry nothing beyond the published schema, and the engine UI shows the owner the exact last payload, so the mock keeps it for the security panel.

## Scope

- `src/domain/registration/register.ts`: `registerEngine(deps): Promise<RegistrationOutcome>` with `RegistrationOutcome = { kind: 'registered'; registration } | { kind: 'already-registered'; registration } | { kind: 'rejected'; reason: 'invalid-code' | 'expired-code' | 'conflict' } | { kind: 'unavailable' }`. Builds the request with C-03's schema (`linkCode`, `enginePublicKey`, `engineVersion`, `mode: "tunnel"`), validates the response strictly, and refuses a response whose `engineId` does not derive from its own public key (C-01) or whose hostname is not `<engineId>.<engine domain>`.
- Ports: `DashboardApi { register(req, signal); heartbeat(engineId, rawBody, signature, signal) }`, `RegistrationStore { load(); save(registration) }`, `SeqStore { next(): Promise<number> }` (returns `max(last + 1, Date.now())`, see C-03), `SystemStats { sample(): { diskPct; ramPct; cpuLoad } }`, `EngineStatsSource { counts(): { agents; members }; updateState(): 'none' | 'available' | 'pending' | 'installing' }`. In-memory adapters for all.
- `src/adapters/fetch-dashboard-api.ts` (`fetch`, timeouts, `PTBK_DASHBOARD_URL`), `src/adapters/fs-registration-store.ts` (`PTBK_DATA_DIR/registration.json`, 0600, strict zod on load), `src/adapters/fs-seq-store.ts` (`PTBK_DATA_DIR/heartbeat-seq`; writes `seq` durably with temp file, `fsync` and rename **before** sending, so a crash never reuses a value; gaps are fine), `src/adapters/os-system-stats.ts` (`node:os` and `fs.statfs`).
- `src/domain/heartbeat/build-heartbeat.ts`: pure; from inputs and `Clock` builds the C-03 payload (`v`, `engineId`, `seq`, `ts` as ISO seconds UTC, `version`, `uptimeS`, `diskPct`, `ramPct` rounded to tens with C-03's rounding rule, `cpuLoad` bucket, `update`, `agents`, `members`), validates it with C-03's strict schema, serialises once, and signs the exact raw bytes (`Ptbk-Signature: ed25519=<base64url>`).
- `src/domain/heartbeat/heartbeat-loop.ts`: Clock-driven, first beat right after the tunnels start, then every 60 s. A failed send is logged with the status code only and not retried before the next tick; missed beats are not backfilled. Keeps the last sent payload (raw JSON) for the security panel.
- `EngineStatsSource` adapter reading counts from M-04's state when present, zeros otherwise; `update` from M-05's loader state when present, `none` otherwise.
- Startup: if registered, load it; else if `PTBK_LINK_CODE` is set, register; else, with no `PTBK_DASHBOARD_URL`, run in M1 dev mode on `PTBK_RELAYS` and `PTBK_ENGINE_DOMAIN` without heartbeats. Relays from the registration replace `PTBK_RELAYS` unless `MOCK_RELAYS_OVERRIDE=enabled`.
- CLI: `mock-engine register --link <code>` performs registration and exits, for X-05.

## Out of scope

- Dashboard endpoints (D-03, D-05). Re-registration or key rotation flows. Fault injection on heartbeats beyond what M-04's fault plan already covers.

## Design notes

- The link code is never logged and never written to disk; it is dropped from memory after the request.
- Mock stats may come from the scenario instead of the OS when `MOCK_STATS=scenario`, so e2e can assert exact dashboard values; default is the OS.
- Heartbeat and registration go straight to the dashboard over HTTPS, not through the relay, honouring `HTTPS_PROXY` and `NO_PROXY` like M-01.

## Acceptance criteria

- [ ] Registration tests with an in-memory `DashboardApi`: success persists the registration and adopts its relays; second start reports `already-registered` without a network call; invalid and expired codes map to their outcomes; a response with a foreign `engineId`, a wrong hostname or an unknown field is refused.
- [ ] Heartbeat tests with fake clock: beats every 60 s; the signature verifies with C-03's verifier over the exact raw body; `ts` equals the clock (within 2 min by construction); 44 % becomes 40 and 46 % becomes 50 (or C-03's documented rule); payload validates against C-03's strict schema and contains no other field.
- [ ] `seq` increases strictly across a simulated crash after persisting but before sending, and across a restart.
- [ ] Dashboard unreachable: no crash, tunnels unaffected, next beat uses the next `seq`.
- [ ] Contract test against D-05's handler (or C-05's heartbeat checks, whichever lands first) accepts the mock's beats and rejects a replayed one.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- If D-03 or C-03 changes how the relay list is delivered or refreshed after registration (it may change when relays are added), the mock must follow; today it is fixed at registration.
- `members` in the heartbeat is a count only; with organisations and roles from day one, confirm with C-03 that no per-role breakdown is wanted (it would be new metadata and must go through the published schema).
