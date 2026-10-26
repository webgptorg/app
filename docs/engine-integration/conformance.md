# Conformance

The real engine replaces the mock engine only by passing the conformance suite, `@ptbk/conformance` ([ADR 0004](../adr/0004-mock-engine-and-conformance.md)). The suite runs against the mock engine in CI on every pull request. The engine team runs all of it in one command that starts the engine itself, or the engine API suite on its own against any engine URL.

Spec: [Build plan](../spec/zero-trust-spec.md#build-plan) (Mock engine first, real engine last), [Security hardening](../spec/zero-trust-spec.md#security-hardening) 7 and 8.

## Status

Every suite runs against the mock engine in CI on every pull request, in one command that starts it (C-12). [`packages/conformance/README.md`](../../packages/conformance/README.md) describes every check, the CLI and the report.

| Suite          | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Status                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `engine-api`   | The HTTP API: engine info, auth, schemas, input strictness, pagination, agents, chat streaming, secrets, audit, permissions, own credentials, cross-member access, gateway                                                                                                                                                                                                                                                                                                                       | Implemented (C-05 v1); `--base-url` or the harness (C-12) |
| `tunnel`       | Acting as the relays the engine dials: WebSocket upgrade, every relay, relay certificate, signed `auth` (fresh nonce, `version`, list encoding), wrong relay, downgrade, invalid handshake messages, TLS inside a stream, unknown SNI, concurrent streams, `WINDOW` both ways, `CLOSE`, ignorable, unknown, malformed and invalid frames, stream IDs, reconnects after closes and rejects, backoff, `REPLACED`, relay restart, ping, `HTTPS_PROXY`                                               | Implemented (C-09); the harness starts the engine         |
| `ui-loader`    | The UI loader black-box, through the harness and a fake release store: install, strict Ed25519, signature threshold, DSSE PAE, strict payload, exact provenance identity and log entry, trusted-time delay persisted across restarts, archive and manifest checks, no downgrade, revocations (freshness, rollback, revoked candidate and active bundle), store failures, update policy, served files and headers. Needs a [conformance build](ui-loader.md#testing-the-loader-conformance-build) | Implemented (C-10)                                        |
| `heartbeat`    | Signature over the exact bytes, strict body, `seq` across restarts, cadence, behaviour on dashboard errors; acting as dashboard, the harness starts the engine                                                                                                                                                                                                                                                                                                                                   | Implemented (C-08)                                        |
| `registration` | Signed request, identity across restarts, link code used once, no secret logged, tolerant and refused answers, error codes, data directory and key file permissions; acting as dashboard, the harness starts the engine                                                                                                                                                                                                                                                                          | Implemented (C-08)                                        |
| capabilities   | Each advertised capability in depth: paging and filters, run cancel and retry, trigger pause, resume and schedules, file downloads, infected files, file counts and upload policies, secrets behind integrations, activity items, test runs of unsaved books (`test-chat@1`); a capability the engine does not advertise skips with `capability-not-advertised`                                                                                                                                  | Implemented (M-07)                                        |

Check IDs are stable dotted names (`engine-api.secrets.never-returned`). Renaming one is a breaking change. Every check ID that exists in the package appears in [checklist.md](checklist.md); a script fails `bun run check` when one is missing.

## Running it

`ptbk-conformance` is a Node 24 CLI, bundled into one file (`dist/ptbk-conformance.js`) so it needs no build step on your side:

- `--base-url <url>`: an engine you started, for the `engine-api` suite on its own. [Below](#an-engine-the-harness-starts), `--engine-cmd` starts the engine instead and runs every suite.
- `--suite <name>` and `--filter <text>`, both repeatable: which checks to run (an ID must contain the text).
- `--report json|junit` and `--out <file>`: the report. JUnit XML is for CI annotations; the JSON report has `startedAt`, `engineVersion`, the `seed` and one result per check (`pass`, `fail` with a detail, or `skip` with a reason).
- `--target-module <file>`: with `--base-url`, a module exporting `createConformanceTarget({ baseUrl, fetch })` (needed for the checks that use members). For owner-only runs, `PTBK_CONFORMANCE_OWNER_COOKIE` instead; checks that need other members then skip.
- `--engine-public-key <key>`: with `--base-url`, checks `GET /engine`'s `engineId` against your key (the harness knows it from the registration). `--no-gateway` skips the gateway check for an API run without the gateway, in either mode.
- `--seed <n>` repeats a run's test data; `--timeout-ms <n>` sets the per-check timeout (default 120000).
- `--mock-control-url <url>` is for the mock engine only: it takes sessions from the mock's dev-only control listener, which a real engine never has.

The exit code is 0 only when no check failed, 1 when one did, and 2 for a usage error. [testing-against-the-platform.md](testing-against-the-platform.md#a-the-conformance-cli) has the commands for a real engine.

## An engine the harness starts

With `--engine-cmd`, the harness starts the engine itself and plays the platform around it. One command runs every suite:

```sh
ptbk-conformance --engine-cmd "node dist/engine.js" --engine-cwd ./my-engine \
  --engine-session-cmd "node dist/engine.js conformance-session" --engine-ca-file "{dataDir}/<its development CA certificate>" \
  --suite engine-api,registration,heartbeat,tunnel,ui-loader
```

For every check of the `registration`, `heartbeat`, `tunnel` and `ui-loader` suites, the harness creates a private temporary directory and starts its fake servers on loopback, under `*.localhost` names, with certificates from a CA it creates for the run. It then runs the engine command (`/bin/sh -c`) with the [launch contract](identity-and-registration.md#launch-contract) variables. It restarts the engine when a check needs a restart, and stops the whole process group at the end. A failed check's report carries the end of the engine's output.

The `engine-api` suite gets one engine for all its checks, registered with the fake dashboard and reached on its own origin through the fake relay, since its checks create and delete their own resources. The harness passes the engine's public key from the registration, so the engine ID check runs. A failed check's report carries the end of that engine's output, and the run's per-check timeout (`--timeout-ms`) applies as with `--base-url`. `engine-api.cross-member.private-resources` skips in this mode: which resources stay private to one member is engine policy that only a target module (with `--base-url`) can name.

- **Trust.** The run's CA reaches the engine as `NODE_EXTRA_CA_CERTS`. It is name-constrained to `localhost` and excludes every IP address, so it cannot vouch for a real site, and its key exists only in the harness's memory.
- **Heartbeat interval.** The heartbeat checks wait for real beats, 60 s apart. If your engine has a development setting for a shorter interval, put it in the command and pass `--heartbeat-interval-s <n>` with the same value. The cadence check then skips, so only a run at the default interval proves the production cadence.
- **Sessions** for checks that use the engine API come from the engine's [conformance-session command](identity-and-registration.md#conformance-sessions) (`--engine-session-cmd`). Without it, the engine API checks that need a session skip.
- **The mock engine** runs as `--engine-cmd "MOCK_SCENARIO=empty node apps/mock-engine/dist/main.mjs"`; `--mock-control` gives each mock engine its dev-only control listener for sessions. With `MOCK_SCENARIO=small-team`, the engine API checks that need existing data (an infected file, an ended trigger) have it.

## Writing a target

A `ConformanceTarget` tells the suite how to reach your engine and how to get sessions:

- `baseUrl` and `fetch`.
- `session(subject)`, where `subject` is `{ kind: 'owner' }` or `{ kind: 'member', permissions }`, returns a cookie or bearer credential, or `null` to skip checks that need that subject.
- Optional: `enginePublicKey`, `gateway: false`, and `memberPrivateResources` (the routes your policy keeps private to the member who created an agent).

Subjects are described by permissions, not role names, because the role-to-permission mapping is engine policy. Every request carries `Origin` (the base URL's origin) and `Sec-Fetch-Site: same-origin`, as a browser on the engine's origin would, so a gateway that checks them accepts the suite. Checks create resources named `conformance-<runId>-…` and delete them after each check, so you can run the suite against a test engine repeatedly.

## Sessions on a real engine

Decided 2026-10-26: the engine's conformance build ships a `conformance-session` command, never an HTTP endpoint, and a production build refuses to run it ([launch contract](identity-and-registration.md#conformance-sessions)). Give it to the harness with `--engine-session-cmd "<engine> conformance-session"`, and every engine the harness starts gets sessions without a target module. Against an engine at `--base-url`, a target module can call the same command.

The mock engine's dev-only control endpoint, which hands out sessions over HTTP, must never be copied into the real engine ([mock-engine.md](mock-engine.md#dev-only-control-endpoint)). Its `conformance-session` command goes through that endpoint because the mock keeps sessions in memory.

The gateway check assumes the gateway runs in front of the API; for an engine API run without the gateway, pass `--no-gateway` (or `gateway: false` in the target) and it skips.
