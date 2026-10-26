# C-08. Platform harness, registration and heartbeat conformance suites

- **Lane:** Contracts · **Module:** `packages/conformance` (plus the conformance CI job, `apps/mock-engine` fixes if a check finds a mock bug) · **Milestone:** M5
- **Depends on:** C-05, M-06
- **Status:** done (#101)
- **Spec:** Interfaces (draft) 1, 4 and 6; Pairing and identity; What our platform can and cannot do (Heartbeat); Build plan (Mock engine first, real engine last); ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md), [0014](../../adr/0014-cryptography.md)

## Goal

`ptbk-conformance --engine-cmd "<command>"` starts the engine under test itself, plays the platform around it (dashboard here; relay in C-09, release store in C-10) on loopback, and checks registration and heartbeat. If every check passes, the engine registers and heartbeats with our dashboard out of the box.

## Context

The engine maintainer wants to implement the protocol in one go, with the conformance suite as the executable definition of done. C-05 covers only the engine API: it needs a running engine at a URL. Suites that act as dashboard, relay or release store must host servers and control the engine's lifecycle (fresh data directory, restarts, broken key permissions), so they are Node-only and live outside the portable `src/` core (C-05 design notes). This task builds the harness those suites share and the two suites that act as the dashboard. C-09 (tunnel, acting as relay) and C-10 (UI loader, acting as release store) plug their fake servers into the same harness.

## Scope

- **`packages/conformance/node/`**, the Node-only part, exported as a second entry `@ptbk/conformance/node`. Like `src/`, it imports only `@ptbk/protocol` and `@ptbk/engine-api` among workspace packages (ESLint), and `node:*` and `ws` are allowed. The portable runner gains a generic `runChecks` so platform checks get the same per-check timeout, cleanup and report as engine API checks.
- **Engine process** (`node/harness/engine-process.ts`). It runs the engine as a shell command in its own process group. The environment is the inherited one without `PTBK_*`, proxy and CA variables, plus the launch contract below. It captures stdout and stderr (capped), restarts with an env patch, stops with SIGTERM and then SIGKILL after 10 s, and kills every engine it started when the check ends or the harness exits, so no process leaks.
- **Platform plug-in interface** (`node/harness/platform.ts`, below). A platform check gets a context with a fresh private temp root, the run's test CA, the engine domain, a factory for engine processes and the expected heartbeat interval. It starts the fake servers it needs itself, through their own modules, and registers them for teardown.
- **Test PKI** (`node/pki/test-ca.ts`): one ephemeral ECDSA P-256 CA per run, name-constrained to `localhost` and excluding every IP address. The engine trusts it through `NODE_EXTRA_CA_CERTS`, which adds to the default roots. C-09 uses the same module for relay certificates and for an untrusted CA of its own.
- **Fake dashboard** (`node/fakes/dashboard.ts`): `REGISTER_PATH` and `heartbeatPath` over HTTPS on loopback (`dashboard.localhost`), verifying with C-03's `verifyRegistration` and `verifyHeartbeat` over the exact bytes. It has real D-03 semantics by default: link codes issued per organisation and consumed once, idempotent same-organisation re-registration, `engine-exists`, `engine-suspended`. It also takes scripted answers per request, and it records every request with its arrival time.
- **CLI**: `--engine-cmd <shell command>`, `--engine-cwd <dir>`, `--heartbeat-interval-s <n>` (expectation, default 60), `--engine-session-cmd <command>` with `--engine-ca-file <file>`, or `--mock-control`, for engine API sessions, and `--suite` (repeatable or comma-separated). Without `--engine-cmd` the CLI behaves as in C-05. A failed check's report carries the engine's output.
- **Conformance sessions** (ENG-99, decided 2026-10-26): the engine's conformance build ships `conformance-session --subject owner|member [--permissions a,b]`, which prints `{"cookie"}`, `{"bearer"}` or `null` as JSON. A production build refuses it, and it is never an HTTP endpoint. `createSessionCommandTargetFactory` (`node/targets/session-command.ts`) runs it with the engine's environment. The mock implements the command over its dev-only control listener, and the self-test exercises that path.
- **`registration` suite** (acting as dashboard), check IDs:
  - `registration.request.signature-verifies`: the request is within `REGISTER_REQUEST_MAX_BYTES`, parses with the strict `RegisterEngineRequest`, carries the configured link code and `mode: tunnel`, and `verifyRegistration` accepts it.
  - `registration.identity.engine-id-derived`: the engine then uses `deriveEngineId(enginePublicKey)` as its engine ID (heartbeat path and body).
  - `registration.identity.stable-across-restarts`: after a restart, the same key and engine ID.
  - `registration.link-code.used-once`: one registration request across a restart with the same environment; the stored registration is used.
  - `registration.secrets.never-logged`: the link code and the private key never appear in the engine's output (raw, hex, base64, base64url), and the link code is in no file under `PTBK_DATA_DIR`.
  - `registration.response.unknown-fields-ignored`: a 200 with an extra field is accepted (tolerant reader).
  - `registration.response.invalid-refused`: an engine ID the key does not derive, a hostname outside the engine domain, or a body over `REGISTER_RESPONSE_MAX_BYTES` is refused. No heartbeat follows, nothing is stored, and a restart registers again.
  - `registration.errors.invalid-link-code`, `.engine-exists`, `.engine-suspended`, `.not-entitled`, `.rate-limited`, `.unavailable` (503): no heartbeat, no tight retry loop (one attempt for the final codes; at most three in 10 s for `rate-limited` and 5xx), the output names the problem `code`, and nothing is stored.
  - `registration.data-dir.private`: the engine creates `PTBK_DATA_DIR` itself as a 0700 directory owned by its UID, not a symbolic link.
  - `registration.key-file.private`: the file under `PTBK_DATA_DIR` that holds the private key of the registered public key (PKCS#8 PEM or DER, JWK, or a raw 32-byte seed) is a regular file, owned by the engine's UID, with mode 0600 or stricter.
  - `registration.key-file.loose-modes-refused`: with the data directory at 0755, the key file group- or world-readable, or the key file replaced by a symbolic link, the engine exits non-zero within 30 s, contacts nobody and names the path.
- **`heartbeat` suite** (acting as dashboard), check IDs:
  - `heartbeat.signature.verifies`: the first heartbeat goes out within 30 s of start, to `heartbeatPath(engineId)`, with `Ptbk-Signature`, and `verifyHeartbeat` accepts it (`ptbk-heartbeat-v1` over the SHA-256 of the exact raw body).
  - `heartbeat.body.strict`: every body is within `HEARTBEAT_MAX_BODY_BYTES`, parses with the strict `Heartbeat` schema (percentages multiples of ten), `ts` is within `HEARTBEAT_MAX_SKEW_MS` of the harness clock, and `version` is the registered `engineVersion`.
  - `heartbeat.seq.increasing-across-restarts`: `seq` strictly increases between beats and across a restart.
  - `heartbeat.cadence.interval`: beats arrive every 60 s (±5 s, +10 s late), and a beat answered 503 is not retried before the next tick. Skips when `--heartbeat-interval-s` overrides the default, so a passing run proves the production cadence.
  - `heartbeat.errors.keeps-sending`: after answers 429 `rate-limited`, 403 `engine-suspended`, 404 `not-found`, 401 `bad-signature` and 401 `stale-timestamp`, the engine keeps running and sends the next beat on the interval, never sooner.
  - `heartbeat.stale-ts.skew-shown`: after `stale-timestamp` answers whose `serverTime` is 10 minutes ahead, the security panel's `clockSkew.seconds` is about −600. It reaches the engine API through C-09's relay (`startTunnelRelay`, `endpointFor`) and skips without a session source.
- **Self-test**: the package test runs both suites against the mock engine (`apps/mock-engine/dist/main.mjs`, built first, `MOCK_HEARTBEAT_INTERVAL_S=2`). It also runs them against `node/testing/fake-engine.ts`, an independent implementation on plain `node:crypto` whose `FAKE_ENGINE_DEFECTS` break one rule each, to prove every check can fail. The conformance CI job runs the suites against the mock, plus the cadence check at the real 60 s.
- **Docs**: the engine launch contract in [identity-and-registration.md](../../engine-integration/identity-and-registration.md#launch-contract); [conformance.md](../../engine-integration/conformance.md) (status rows, running with `--engine-cmd`); every new check ID in [checklist.md](../../engine-integration/checklist.md); the package README.

## Engine launch contract

The harness sets these variables. An engine must honour them, and none of them weakens a production engine:

| Variable              | Harness value                                    | Why it is safe in production                                                                               |
| --------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `PTBK_DATA_DIR`       | A path that does not exist yet, in a 0700 parent | Spec Interface 6                                                                                           |
| `PTBK_MODE`           | `tunnel`                                         | Spec Interface 6                                                                                           |
| `PTBK_ENGINE_DOMAIN`  | `engine.localhost`                               | The registration response is checked against it, so a wrong value only makes registration fail             |
| `PTBK_DASHBOARD_URL`  | `https://dashboard.localhost:<port>`             | Operator configuration; the dashboard grants nothing inside the engine                                     |
| `PTBK_LINK_CODE`      | A fresh link code                                | One-time and never stored or logged                                                                        |
| `NODE_EXTRA_CA_CERTS` | The run's test CA (PEM)                          | Adds a root and never replaces the defaults, as an operator does for a TLS-inspecting proxy (tunnel guide) |

The harness removes `HTTPS_PROXY`, `NO_PROXY` (both cases) and any inherited `PTBK_*` from the engine's environment. Engine-specific development settings go into the command itself (`env MOCK_SCENARIO=empty node dist/main.mjs`). Behaviour the harness relies on:

- On SIGTERM the engine exits within 10 s.
- When it refuses to start (key or data directory safety, configuration), it exits with a non-zero status.
- It writes its logs to stdout or stderr.

`PTBK_RELAYS` is part of the contract too (decided 2026-10-26): an operator-trusted override (`wss://host[:port]` list) that replaces the registration's relays, safe because the engine verifies relay TLS and a relay never sees plaintext. The harness needs it because bare relay hostnames mean port 443, which loopback tests cannot bind. The mock engine's `MOCK_RELAYS_OVERRIDE` gate is dropped for it (this task). C-09 uses it; C-10 adds `PTBK_UI_RELEASE_URL`, `PTBK_UPDATE_POLICY`, `PTBK_PINNED_VERSION` and `PTBK_CONFORMANCE_TRUST_FILE` (a build-time-gated conformance build; a production build refuses to start with it).

## Platform plug-in interface

```ts
// node/harness/platform.ts
interface PlatformCheck {
    readonly id: string;
    readonly suite: string;
    readonly title: string;
    /** Minimum per-check timeout, e.g. for checks that wait for several heartbeat intervals. */
    timeoutMs?(ctx: PlatformExpectations): number;
    run(ctx: PlatformCheckContext): Promise<CheckOutcome>;
}
interface PlatformSuite {
    readonly id: string;
    readonly checks: readonly PlatformCheck[];
}
interface PlatformCheckContext extends BaseCheckContext {
    readonly ca: TestCa; // trusted by the engine through NODE_EXTRA_CA_CERTS
    readonly engineDomain: Hostname;
    readonly expectations: PlatformExpectations; // { heartbeatIntervalMs, startTimeoutMs }
    tempDir(label: string): Promise<string>; // 0700, removed after the check
    engine(options?: EngineOptions): Promise<EngineProcess>; // not started, fresh empty data dir; stopped after the check
    use<T extends Closable>(fixture: T): T; // closed after the check, newest first
    /** The engine API once a relay routes it (C-09), or null without a session source (--mock-control, a target factory). */
    engineTarget(engine: EngineProcess, endpoint: EngineApiEndpoint): ConformanceTarget | null;
}
interface EngineOptions {
    readonly env?: LaunchEnv; // merged over the harness's own variables
    readonly dataDir?: string; // default: <fresh temp>/data, not created
}
interface EngineProcess {
    readonly dataDir: string;
    readonly env: Readonly<Record<string, string>>;
    readonly running: boolean;
    readonly exits: readonly EngineExit[];
    start(): Promise<void>;
    stop(): Promise<EngineExit>;
    restart(patch?: Readonly<Record<string, string | null>>): Promise<void>;
    waitForExit(timeoutMs: number): Promise<EngineExit | null>;
    logs(): string;
}
// node/fakes/dashboard.ts
startFakeDashboard(ctx, options?): Promise<FakeDashboard>; // .env: PTBK_DASHBOARD_URL; issueLinkCode(org)
startRegisteredEngine(ctx, options?): Promise<RegisteredEngine>; // { engine, dashboard, linkCode, identity, restart(patch?), nextAcceptedHeartbeat(afterMs) }
```

A suite that is not about registration (tunnel, UI loader) calls `startRegisteredEngine(ctx, { relays, env })`. It resolves once the engine has registered with a fake dashboard answering `relays` and sent its first accepted heartbeat, with `identity` (engine ID and public key). An accepted heartbeat after a (re)start is the harness's ready signal, because every engine sends one as soon as it is up, registered or not. `restart(patch)` keeps the data directory and resolves at that signal.

**Engine API sessions.** `EngineTargetFactory` (`engineEnv()` before each spawn, `target(engine, endpoint)`) is how a run gets a `ConformanceTarget` for an engine it started. With `--mock-control`, each mock engine gets its own dev-only control listener on a loopback port chosen before spawn and kept across restarts, and `session()` signs in through `POST /__mock/sessions` on every call, so it works again after a restart. A real engine brings its own factory through a target module: this is the open "conformance sessions" point (ENG-99).

## Out of scope

- The tunnel suite and fake relay (C-09), the UI loader suite and fake release store (C-10).
- Running the engine API suite against an engine the harness started. It needs C-09's relay, the engine's own certificate (ACME in a real engine, so a fake ACME CA) and a session; see Risks.

## Design notes

- Checks run one after another, each with its own engine and data directory, so a broken check cannot poison the next one. Waits are event-driven on the fake dashboard's request log, never fixed sleeps, except the "nothing more happens" windows that a check has to observe.
- Restarts reuse the data directory. Key-permission checks change modes in place and restore them for cleanup.
- Reports and failure details name paths, codes and counts, never request bodies or keys. Engine output appears only for a failed check, capped to its last 16 KiB.
- Without `--engine-cmd`, `registration` and `heartbeat` are not offered; selecting them is a usage error that says `--engine-cmd` is needed.

## Acceptance criteria

- [x] `ptbk-conformance --engine-cmd "node apps/mock-engine/dist/main.mjs"` (with `MOCK_HEARTBEAT_INTERVAL_S` set in the command) passes every registration and heartbeat check against the mock engine (with `--mock-control` for the engine API), except `heartbeat.cadence.interval` (skip: interval overridden). The same run at the default interval passes the cadence check.
- [x] For every check, a broken fake engine in the self-test makes it fail.
- [x] No engine process outlives a check, a failed run or Ctrl-C (a test asserts the process group is gone).
- [x] Coverage of `node/` is at least 90% lines and branches (it verifies signatures).
- [x] Every new check ID is in checklist.md (`bun run check` enforces it); conformance.md, identity-and-registration.md and the README describe the launch contract and harness mode.
- [x] The conformance CI job runs the harness against the mock engine.
- [x] `bun run check` passes (fast policy for #101: conformance and mock-engine lint, typecheck and tests, plus the conformance job replay).
- [x] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- **Trust for a non-Node engine.** `NODE_EXTRA_CA_CERTS` is Node's, and the engine is TypeScript on Node. Decided 2026-10-26: no non-Node trust variable for now.
- **Heartbeat interval.** Decided 2026-10-26: the cadence check runs at the real 60 s, and the contract has no interval setting. The check skips when the run overrides the interval, which only speeds up the other checks through an engine's own development setting.
- **Registration failure behaviour.** This task makes "tell the owner, do not retry" testable: the output names the `code`, and a retryable failure waits at least 5 s and backs off. It is to confirm in the engine-team review (guide open points). The missing `REGISTRATION_ERROR_CODE` values (`not-entitled`, `rate-limited`) are task C-11.
- **Engine API through the harness**: works through C-09's relay. Decided 2026-10-26: the conformance build serves its API certificate from a development CA whose certificate file is in the data directory (the mock's `<dataDir>/dev-ca/ca-cert.pem` pattern), passed as `--engine-ca-file "{dataDir}/…"`.
- **Watch windows.** A check that must see nothing happen (no retry loop, no heartbeat) watches for 8 s by default. That catches a tight loop, not a slow one, and it is why a retrying engine must wait at least 5 s before its first retry.
