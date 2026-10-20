# Conformance

The real engine replaces the mock engine only by passing the conformance suite, `@ptbk/conformance` ([ADR 0004](../adr/0004-mock-engine-and-conformance.md)). The suite runs against the mock engine in CI on every pull request, and the engine team can run it standalone against any engine URL.

Spec: [Build plan](../spec/zero-trust-spec.md#build-plan) (Mock engine first, real engine last), [Security hardening](../spec/zero-trust-spec.md#security-hardening) 7 and 8.

## Status

**The suite has no checks yet.** [`packages/conformance`](../../packages/conformance/README.md) is a placeholder until task C-05 lands. Everything below describes C-05's planned interface; names may still change, and this page is updated when C-05 merges. Until then, use the golden vectors and the contract packages' own tests.

| Suite          | What it checks                                                                                                                                               | Status                                 |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| `engine-api`   | The HTTP API: auth, schemas, input strictness, pagination, secrets, agents, chat streaming, audit, permissions, security panel, cross-member access, gateway | Planned (C-05 v1)                      |
| `tunnel`       | Handshake signing, list encoding and downgrade refusal, acting as relay                                                                                      | Check IDs registered as `skip` in C-05 |
| `ui-loader`    | Strict Ed25519, DSSE PAE, exact provenance identity, trusted-time delay, expired revocations                                                                 | Check IDs registered as `skip` in C-05 |
| `heartbeat`    | Signed heartbeat, acting as dashboard                                                                                                                        | Later                                  |
| `registration` | Signed registration, acting as dashboard                                                                                                                     | Later                                  |
| capabilities   | Each advertised capability (`runs@1` and the others)                                                                                                         | Later (M-07 extends C-05)              |

Check IDs are stable dotted names (`engine-api.secrets.never-returned`). Renaming one is a breaking change. Every check ID that exists in the package appears in [checklist.md](checklist.md); a script fails `bun run check` when one is missing.

## Running it (planned)

C-05 plans a Node 24 CLI, `ptbk-conformance`, bundled so it runs without a build step on your side:

- `--base-url <url>`: the engine to test.
- `--suite <name>` and `--filter <pattern>`: which checks to run.
- `--report json|junit` and `--out <file>`: the report. JUnit XML is for CI annotations; the JSON report has `startedAt`, `engineVersion` and one result per check (`pass`, `fail` with a detail, or `skip` with a reason).
- `--target-module <file>`: a module exporting your `ConformanceTarget` (needed for permission checks). For owner-only runs, `PTBK_CONFORMANCE_OWNER_COOKIE` instead; checks that need other members then skip.

The exit code is 0 only when no check failed.

## Writing a target (planned)

A `ConformanceTarget` tells the suite how to reach your engine and how to get sessions:

- `baseUrl` and `fetch`.
- `session(subject)`, where `subject` is `{ kind: 'owner' }` or `{ kind: 'member', permissions }`, returns a cookie or bearer credential, or `null` to skip checks that need that subject.

Subjects are described by permissions, not role names, because the role-to-permission mapping is engine policy. Checks create resources named `conformance-<runId>-…` and delete them at the end, so you can run the suite against a test engine repeatedly.

## Sessions on a real engine

How the suite obtains a session on an engine whose only sign-in is a passkey is an **open point for the engine team**, and it must be agreed before the real engine swaps in (task E-03). Options:

- A test-only session bootstrap behind a flag that is off by default and refused in production builds.
- Scoped API tokens for chosen permission sets.
- WebAuthn virtual authenticators driving the real sign-in.

The mock engine's answer, a dev-only control endpoint that hands out sessions, must never be copied into the real engine ([mock-engine.md](mock-engine.md#dev-only-control-endpoint)).

The suite assumes the gateway runs in front of the API for the gateway checks; for an engine API run without the gateway, those checks must be skippable.
