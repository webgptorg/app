# Conformance

The real engine replaces the mock engine only by passing the conformance suite, `@ptbk/conformance` ([ADR 0004](../adr/0004-mock-engine-and-conformance.md)). The suite runs against the mock engine in CI on every pull request, and the engine team can run it standalone against any engine URL.

Spec: [Build plan](../spec/zero-trust-spec.md#build-plan) (Mock engine first, real engine last), [Security hardening](../spec/zero-trust-spec.md#security-hardening) 7 and 8.

## Status

The `engine-api` suite (C-05 v1, capability checks from M-07) runs against the mock engine in CI on every pull request. [`packages/conformance/README.md`](../../packages/conformance/README.md) describes every check, the CLI and the report.

| Suite          | What it checks                                                                                                                                                                                                                                                                                                      | Status                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `engine-api`   | The HTTP API: engine info, auth, schemas, input strictness, pagination, agents, chat streaming, secrets, audit, permissions, own credentials, cross-member access, gateway                                                                                                                                          | Implemented (C-05 v1)                                        |
| `tunnel`       | Handshake signing, list encoding and downgrade refusal, acting as relay                                                                                                                                                                                                                                             | Check IDs registered, reported as `skip`; suite pending C-09 |
| `ui-loader`    | Strict Ed25519, DSSE PAE, exact provenance identity, trusted-time delay, expired revocations                                                                                                                                                                                                                        | Check IDs registered, reported as `skip`; suite pending C-10 |
| `heartbeat`    | Signed heartbeat, acting as dashboard                                                                                                                                                                                                                                                                               | Pending C-08                                                 |
| `registration` | Signed registration, acting as dashboard                                                                                                                                                                                                                                                                            | Pending C-08                                                 |
| capabilities   | Each advertised capability in depth: paging and filters, run cancel and retry, trigger pause, resume and schedules, file downloads, infected files, file counts and upload policies, secrets behind integrations, activity items; a capability the engine does not advertise skips with `capability-not-advertised` | Implemented (M-07)                                           |

Check IDs are stable dotted names (`engine-api.secrets.never-returned`). Renaming one is a breaking change. Every check ID that exists in the package appears in [checklist.md](checklist.md); a script fails `bun run check` when one is missing.

## Running it

`ptbk-conformance` is a Node 24 CLI, bundled into one file (`dist/ptbk-conformance.js`) so it needs no build step on your side:

- `--base-url <url>`: the engine to test.
- `--suite <name>` and `--filter <text>`, both repeatable: which checks to run (an ID must contain the text).
- `--report json|junit` and `--out <file>`: the report. JUnit XML is for CI annotations; the JSON report has `startedAt`, `engineVersion`, the `seed` and one result per check (`pass`, `fail` with a detail, or `skip` with a reason).
- `--target-module <file>`: a module exporting `createConformanceTarget({ baseUrl, fetch })` (needed for the checks that use members). For owner-only runs, `PTBK_CONFORMANCE_OWNER_COOKIE` instead; checks that need other members then skip.
- `--engine-public-key <key>` checks `GET /engine`'s `engineId` against your key; `--no-gateway` skips the gateway check for an API run without the gateway.
- `--seed <n>` repeats a run's test data; `--timeout-ms <n>` sets the per-check timeout (default 120000).
- `--mock-control-url <url>` is for the mock engine only: it takes sessions from the mock's dev-only control listener, which a real engine never has.

The exit code is 0 only when no check failed, 1 when one did, and 2 for a usage error. [testing-against-the-platform.md](testing-against-the-platform.md#a-the-conformance-cli) has the commands for a real engine, including the `--engine-cmd` mode that C-08 adds.

## Writing a target

A `ConformanceTarget` tells the suite how to reach your engine and how to get sessions:

- `baseUrl` and `fetch`.
- `session(subject)`, where `subject` is `{ kind: 'owner' }` or `{ kind: 'member', permissions }`, returns a cookie or bearer credential, or `null` to skip checks that need that subject.
- Optional: `enginePublicKey`, `gateway: false`, and `memberPrivateResources` (the routes your policy keeps private to the member who created an agent).

Subjects are described by permissions, not role names, because the role-to-permission mapping is engine policy. Every request carries `Origin` (the base URL's origin) and `Sec-Fetch-Site: same-origin`, as a browser on the engine's origin would, so a gateway that checks them accepts the suite. Checks create resources named `conformance-<runId>-…` and delete them after each check, so you can run the suite against a test engine repeatedly.

## Sessions on a real engine

How the suite obtains a session on an engine whose only sign-in is a passkey is an **open point for the engine team**, and it must be agreed before the real engine swaps in (task E-03). Options:

- A test-only session bootstrap behind a flag that is off by default and refused in production builds.
- Scoped API tokens for chosen permission sets.
- WebAuthn virtual authenticators driving the real sign-in.

The mock engine's answer, a dev-only control endpoint that hands out sessions, must never be copied into the real engine ([mock-engine.md](mock-engine.md#dev-only-control-endpoint)).

The gateway check assumes the gateway runs in front of the API; for an engine API run without the gateway, pass `--no-gateway` (or `gateway: false` in the target) and it skips.
