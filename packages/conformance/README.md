# @ptbk/conformance

The suite any engine must pass to replace the mock engine ([ADR 0004](../../docs/adr/0004-mock-engine-and-conformance.md)). It checks an engine at a base URL against the engine API contract and reports pass, fail or skip per check. It runs against the mock engine in CI on every pull request, and engine teams run it standalone against their own engine.

MIT, moves to the public repo with the other contracts ([ADR 0002](../../docs/adr/0002-public-private-split.md)). Plan: task C-05. `conformance` imports only `@ptbk/protocol` and `@ptbk/engine-api`, and its core (`src/`) is portable: `fetch` and WebCrypto only. The CLI in `bin/` is the Node part.

## What it checks

- **`engine-api`** (v1): the HTTP API engine-ui depends on (C-04, C-07), reached through the engine gateway as a browser would. Every response it reads is judged strictly: a success must parse with its route's strict schema (no undeclared fields), and every 4xx and 5xx must be `application/problem+json` with a known `code` and the status that code always has. A violation in any check fails that check.
- **`tunnel`** and **`ui-loader`**: their check IDs are registered now and always report `skip` (`not-implemented`), so engine teams can track the cryptographic requirements of [ADR 0014](../../docs/adr/0014-cryptography.md) before those suites exist. Heartbeat and registration suites come later.

Check IDs are stable: engine teams track results by them, so renaming one is a breaking change. Every ID is listed in the engine integration guide's [checklist](../../docs/engine-integration/checklist.md).

## Build and run

```sh
bun run --filter @ptbk/conformance build   # → packages/conformance/dist/ptbk-conformance.js
node packages/conformance/dist/ptbk-conformance.js --base-url https://<engine> --target-module ./my-target.mjs
```

The bundle is one file that runs on Node 24 with no `node_modules`; `bin` in `package.json` points to it, so a published package runs as `ptbk-conformance`. In development the source runs with `bun bin/ptbk-conformance.ts`.

```
Usage: ptbk-conformance --base-url <https://engine> [options]

Credentials (one of):
  --target-module <file>      A module exporting createConformanceTarget({ baseUrl, fetch }) → ConformanceTarget
  --mock-control-url <url>    The mock engine's control listener (development only)
  PTBK_CONFORMANCE_OWNER_COOKIE=<name=value>
                              An owner session cookie; checks that need members then skip

Options:
  --suite <id>                Run only this suite (repeatable): engine-api, tunnel, ui-loader
  --filter <text>             Run only checks whose ID contains this text (repeatable)
  --report json|junit         Report format (default json)
  --out <file>                Write the report here instead of stdout
  --engine-public-key <key>   The engine's Ed25519 public key (base64url), to check its engine ID
  --no-gateway                The API runs without the engine gateway; gateway checks skip
  --seed <n>                  Repeat a run's test data (the report records the seed)
  --timeout-ms <n>            Per check (default 120000)
```

The exit code is 0 only when no check failed, 1 when one did, and 2 for a usage error. Progress goes to stderr, one line per check. For an engine whose certificate comes from a development CA, pass the CA to Node with `NODE_EXTRA_CA_CERTS=<ca.pem>`.

## Credentials: write a target

The suite needs sessions: the owner, and members holding exactly the permissions a check chooses. Each engine provides them its own way, through a `ConformanceTarget`. A target module exports:

```ts
import type { ConformanceTarget } from '@ptbk/conformance';

export async function createConformanceTarget({
  baseUrl,
  fetch,
}: {
  baseUrl: URL;
  fetch: typeof fetch;
}): Promise<ConformanceTarget> {
  return {
    baseUrl,
    fetch,
    async session(subject) {
      // subject: { kind: 'owner' } | { kind: 'member', permissions: Permission[] }
      // Return { cookie: '<name>=<value>' } or { bearer: '<token>' }, or null to skip the checks that need it.
      return null;
    },
    // Optional:
    // enginePublicKey: '<base64url Ed25519>',  // checks GET /engine's engineId against the key
    // gateway: false,                           // the API runs without the gateway; the gateway check skips
    // memberPrivateResources: { permissions, agentRoutes }, // what your policy keeps private to an agent's creator
  };
}
```

Subjects are permission sets, never role names: which role holds which permission is engine policy, and the contract only guarantees that the owner holds every permission. A `member` subject should be a fresh test member each time, so two calls give two different members. How a passkey-only engine hands out such sessions is an open point for the engine team ([conformance guide](../../docs/engine-integration/conformance.md#sessions-on-a-real-engine)).

For an owner-only run, set `PTBK_CONFORMANCE_OWNER_COOKIE` to the session cookie (`name=value`); checks that need members then skip.

**Your gateway sees what a browser sends.** Every request carries `Origin` (the base URL's origin, port included) and `Sec-Fetch-Site: same-origin`, plus the session as `Cookie` (or `Authorization: Bearer`). A gateway that enforces Fetch Metadata and `Origin` on state-changing requests, as it should, must accept these; the gateway check then sends `Sec-Fetch-Site: cross-site` with a foreign `Origin` and expects 403.

## What a run does to the engine

- Everything it creates is named `conformance-<runId>-…` and removed after each check, whatever its outcome: agents are soft-deleted; folders, secrets, API tokens, files, triggers and integrations are deleted or revoked. Chats cannot be deleted through the API and stay behind.
- It sends chat messages, so the engine generates replies; it reads them to the end.
- With `runs@1` it cancels the run its own chat turn started, and retries one failed run, asking the retry to stop right away; with `triggers@1` its schedules lie a year ahead, so none fires during a run.
- It never revokes the owner's passkeys or sessions; revocation checks act on test members' own credentials.
- Reports never contain secret values, cookies or tokens: failure details name routes, fields and codes, never response bodies.

## The report

JSON (`--report json`): `startedAt`, `finishedAt`, `engineVersion` (from `GET /security`, or `null`), `seed`, `runId`, `results` and `summary` (`passed`, `failed`, `skipped`). Each result has `id`, `suite`, `title`, `outcome` (`{ kind: 'pass' }`, `{ kind: 'fail', detail }` or `{ kind: 'skip', reason }`), `durationMs` and `cleanupFailures` (cleanup steps that failed; the outcome stands, but something may be left behind).

JUnit XML (`--report junit`): one `<testsuite>` per suite, one `<testcase>` per check named by its ID, with `<failure>` or `<skipped>`, for CI annotations.

Rerunning with the report's `seed` reproduces the names and values a run used.

## Checks

| ID                                               | What it checks                                                                                                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engine-api.engine.info`                         | `GET /engine` sends `engineId` and `capabilities` (API 1.1), nothing undeclared, and the hostname the API was reached on                                                                       |
| `engine-api.engine.id-matches-key`               | `engineId` is derived from the engine's public key; skips without `enginePublicKey`                                                                                                            |
| `engine-api.capabilities.unadvertised-404`       | Every route of a capability the engine does not advertise answers 404 `capability-not-supported`; skips when all are advertised                                                                |
| `engine-api.security.heartbeat-body`             | The security panel's `lastHeartbeat.body` is a protocol `Heartbeat` naming this engine; skips until the engine has sent a heartbeat                                                            |
| `engine-api.auth.unauthenticated-401`            | Every route without credentials answers 401 `unauthenticated` and carries no resource names                                                                                                    |
| `engine-api.schemas.responses-strict`            | Every GET route (JSON, SSE and downloads) answers with exactly its strict schema                                                                                                               |
| `engine-api.schemas.problems`                    | Unknown IDs, an invalid book, a malformed body and an unknown path answer problem+json with the right code                                                                                     |
| `engine-api.input.unknown-body-field`            | A body with an undeclared field is refused with 400 `validation-failed`                                                                                                                        |
| `engine-api.input.limit-too-large`               | A page `limit` above 100 is refused with 400 `validation-failed`                                                                                                                               |
| `engine-api.input.garbage-cursor`                | A cursor the engine never issued is refused with 400 `invalid-cursor`                                                                                                                          |
| `engine-api.pagination.walk`                     | Five new agents, secrets and folders walked with `limit` 2: no duplicates, no gaps, a final `nextCursor: null`                                                                                 |
| `engine-api.agents.create-and-list`              | An agent created from a book is listed and serves its source                                                                                                                                   |
| `engine-api.agents.revision-conflict`            | A source update from a stale `baseRevisionId` is 409 `revision-conflict` and changes nothing                                                                                                   |
| `engine-api.agents.delete-restore`               | Deleting hides an agent from the list; restoring brings it back                                                                                                                                |
| `engine-api.agents.validate-diagnostics`         | A broken book gets an `error` diagnostic, and creating from it is 422 `invalid-book`                                                                                                           |
| `engine-api.chat.reply-stream`                   | A posted message streams its reply as SSE: deltas count up, one terminal event, and `completed` equals the stored message                                                                      |
| `engine-api.chat.resume-no-duplicates`           | Reconnecting with `Last-Event-ID` repeats no delta                                                                                                                                             |
| `engine-api.secrets.never-returned`              | A secret value (a random canary) never comes back from any GET route or the event stream, raw, hex or base64                                                                                   |
| `engine-api.secrets.lifecycle`                   | Replace, revoke and delete change a secret's metadata as the contract says; a revoked secret refuses a new value                                                                               |
| `engine-api.runs.paging`                         | `GET /runs` (oldest first, bounded by the time the check started) walked in small pages equals one large page; the status, agent and source filters list only matching runs                    |
| `engine-api.runs.cancel-idempotent`              | The run a chat turn starts is cancelled twice: 202 both times with the same `cancelRequestedAt`; once it finished, 409 `run-finished`; skips when a chat turn starts no run                    |
| `engine-api.runs.retry-only-failed`              | Retrying a completed or cancelled run is 409 `run-not-retryable` and creates nothing; a failed run's retry is a new run with `retryOf`, cancelled again right away                             |
| `engine-api.files.paging`                        | Five uploads walked with `limit` 3 equal one large page; `q`, `purpose` and `scan` filters list only matching files                                                                            |
| `engine-api.files.download-attachment`           | An upload downloads byte for byte as an attachment with `nosniff`, for the file and its version                                                                                                |
| `engine-api.files.infected-refused`              | An infected file (and its version) is 409 `file-infected`; skips when the engine lists none                                                                                                    |
| `engine-api.triggers.paging`                     | Five far-future schedules walked in small pages equal one large page; `agentId`, `kind` and `lifecycle` filters list only matching triggers; each names its agent                              |
| `engine-api.triggers.pause-resume-idempotent`    | A second pause or resume changes nothing; resuming an ended trigger is 409 `trigger-ended` and changes nothing                                                                                 |
| `engine-api.triggers.invalid-schedule`           | A bad cron, an unknown time zone and an end before the start are each 422 `invalid-schedule` whose `errors` names the field                                                                    |
| `engine-api.triggers.stats`                      | A new schedule counts as active and, paused, as paused; `nextFireAt` is no later than its next fire; the engine-wide count covers the agent's                                                  |
| `engine-api.integrations.paging`                 | Five MCP servers walked in small pages equal one large page; `agentId`, `kind`, `status` and status-set filters list only matching integrations; `includeEngineWide` adds the engine-wide ones |
| `engine-api.integrations.secrets-never-returned` | A secret an integration references by name comes back resolved, and its value (a canary) never appears in integration, activity or event bytes, in any encoding                                |
| `engine-api.integrations.stats`                  | A new, disabled MCP server counts as disconnected for its agent; every engine-wide count covers the agent's                                                                                    |
| `engine-api.activity.known-items`                | Every activity item parses as a kind and version this contract knows (never unknown, invalid or without a base)                                                                                |
| `engine-api.activity.paging`                     | Activity before the check walked in small pages equals one large page, newest first; `kind=run.` lists only runs                                                                               |
| `engine-api.audit.mutations-recorded`            | Every mutation is in `/audit` with the acting member, its action and its target                                                                                                                |
| `engine-api.audit.hash-chain`                    | Within a page, each entry's `prevHash` is the previous entry's `hash`; `/audit/verify` is intact                                                                                               |
| `engine-api.permissions.owner-holds-all`         | The owner's `/me` lists every permission                                                                                                                                                       |
| `engine-api.permissions.mutations-denied`        | Every mutating route refuses a member lacking only its permission with 403 `forbidden` and that `requiredPermission`, changing nothing                                                         |
| `engine-api.permissions.denials-audited`         | Each of those refusals is in `/audit` with outcome `denied` and the refused member                                                                                                             |
| `engine-api.permissions.read-only-member`        | A member with only `.read` permissions can call every read route they cover                                                                                                                    |
| `engine-api.me.own-sessions`                     | A viewer-like member lists and revokes their own sessions; revoke-others keeps the current one                                                                                                 |
| `engine-api.me.own-passkeys`                     | A viewer-like member lists their own passkeys and revokes one, never the last; skips when the member has no passkey                                                                            |
| `engine-api.me.others-credentials-404`           | Another member's or an unknown session or passkey ID under `/me` is 404, never 403, and nothing is revoked                                                                                     |
| `engine-api.cross-member.private-resources`      | A second member with the same permissions gets 403 or 404 on another's private agent; skips unless the target reports such resources                                                           |
| `engine-api.gateway.cross-site-refused`          | A state-changing request with `Sec-Fetch-Site: cross-site` is 403 even with a valid session; skips with `gateway: false`                                                                       |
| `tunnel.negotiation.downgrade-refused`           | Not implemented yet (skip)                                                                                                                                                                     |
| `tunnel.auth.list-encoding`                      | Not implemented yet (skip)                                                                                                                                                                     |
| `tunnel.auth.version-signed`                     | Not implemented yet (skip)                                                                                                                                                                     |
| `ui-loader.signature.strict-ed25519`             | Not implemented yet (skip)                                                                                                                                                                     |
| `ui-loader.dsse.pae-only`                        | Not implemented yet (skip)                                                                                                                                                                     |
| `ui-loader.provenance.exact-identity`            | Not implemented yet (skip)                                                                                                                                                                     |
| `ui-loader.delay.trusted-time`                   | Not implemented yet (skip)                                                                                                                                                                     |
| `ui-loader.revocations.expired-keeps-current`    | Not implemented yet (skip)                                                                                                                                                                     |

Every `runs`, `files`, `triggers` and `integrations` check skips with reason `capability-not-advertised` when `GET /engine` does not list that capability; the permission checks cover every mutating route of each advertised capability.

### Audit expectations

The contract fixes the action names (`AUDIT_ACTIONS`); the suite expects each mutating route's entry to carry the action named for it and a target of the kind the route acts on, with the ID from its path or, for a create, the created resource. For example `PATCH /agents/{agentId}` is `agent.update` on the agent, `POST /chats/{chatId}/messages` is `chat.message.send` on the chat, `POST /chats/{chatId}/messages/{messageId}/cancel` is `chat.reply.cancel` on the message, and settings changes have no target. The full table is `AUDIT_EXPECTATIONS` in `src/suites/engine-api/audit.ts`.

## Against the mock engine (this repo)

The `conformance` CI job starts a relay and the mock engine on loopback (with `*.localhost` names and a fixed seed), runs the bundled CLI through the relay with `--mock-control-url` and uploads the JUnit report; a failing check fails the job. The mock target (`createMockEngineTarget`) gets sessions from the mock's dev-only control listener; the real engine never has that endpoint.

## Development

`bun run --filter @ptbk/conformance test` builds the bundle and runs the self-test: the whole suite against an in-process engine built on `@ptbk/engine-api/in-memory` (which must pass every check), against deliberately broken variants of it (each must fail its matching check), and the bundled CLI against an engine over HTTP.
