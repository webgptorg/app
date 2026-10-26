# @ptbk/conformance

The suite any engine must pass to replace the mock engine ([ADR 0004](../../docs/adr/0004-mock-engine-and-conformance.md)). It checks an engine at a base URL against the engine API contract and reports pass, fail or skip per check. It runs against the mock engine in CI on every pull request, and engine teams run it standalone against their own engine.

MIT, moves to the public repo with the other contracts ([ADR 0002](../../docs/adr/0002-public-private-split.md)). Plan: task C-05. `conformance` imports only `@ptbk/protocol` and `@ptbk/engine-api`, and its core (`src/`) is portable: `fetch` and WebCrypto only. The CLI in `bin/` is the Node part.

## What it checks

- **`engine-api`** (v1): the HTTP API engine-ui depends on (C-04, C-07), reached through the engine gateway as a browser would. Every response it reads is judged strictly: a success must parse with its route's strict schema (no undeclared fields), and every 4xx and 5xx must be `application/problem+json` with a known `code` and the status that code always has. A violation in any check fails that check.
- **`registration`** and **`heartbeat`** (C-08): the harness starts the engine itself and acts as the dashboard ([below](#starting-the-engine)).
- **`tunnel`** (C-09, starts the engine): acts as the relays the engine dials, from a fake relay on loopback whose names the engine gets in `PTBK_RELAYS`. It checks the handshake (signatures, negotiation, refusals), TLS ended by the engine inside a stream, framing and flow control, reconnects and backoff, liveness and the proxy. See [tunnel-client.md](../../docs/engine-integration/tunnel-client.md#conformance).
- **`ui-loader`** (C-10, starts the engine): the engine's UI loader, black-box. The harness runs a [conformance build](../../docs/engine-integration/ui-loader.md#testing-the-loader-conformance-build) of the engine against a fake release store, restarts it per scenario and reaches its API through C-09's fake relay; see [UI loader suite](#ui-loader-suite).

Check IDs are stable: engine teams track results by them, so renaming one is a breaking change. Every ID is listed in the engine integration guide's [checklist](../../docs/engine-integration/checklist.md).

## Build and run

```sh
bun run --filter @ptbk/conformance build   # → packages/conformance/dist/ptbk-conformance.js
node packages/conformance/dist/ptbk-conformance.js --base-url https://<engine> --target-module ./my-target.mjs
```

The bundle is one file that runs on Node 24 with no `node_modules`; `bin` in `package.json` points to it, so a published package runs as `ptbk-conformance`. In development the source runs with `bun bin/ptbk-conformance.ts`.

```
Usage: ptbk-conformance --base-url <https://engine> [options]
       ptbk-conformance --engine-cmd <shell command> [options]

Credentials (one of):
  --target-module <file>      A module exporting createConformanceTarget({ baseUrl, fetch }) → ConformanceTarget
  --mock-control-url <url>    The mock engine's control listener (development only)
  PTBK_CONFORMANCE_OWNER_COOKIE=<name=value>
                              An owner session cookie; checks that need members then skip

Starting the engine (the harness plays the dashboard and the rest of the platform):
  --engine-cmd <command>      Starts the engine under test (run by /bin/sh), once per check and scenario
  --engine-cwd <dir>          Its working directory (default: the current one)
  --heartbeat-interval-s <n>  The interval the engine was told to use (default 60; anything else skips the cadence check)
  --engine-session-cmd <cmd>  The engine's conformance-session command, run with --subject owner|member
                              [--permissions a,b]; it prints {"cookie"}, {"bearer"} or null as JSON
  --engine-ca-file <file>     The CA the engine's own certificates chain to under test ({dataDir} for its data
                              directory); with --engine-session-cmd
  --mock-control              The engine is the mock engine: sessions from its dev-only control listener

Options:
  --suite <id>                Run only these suites (repeatable or comma-separated)
                              against --base-url: engine-api
                              with --engine-cmd: registration, heartbeat, tunnel, ui-loader
  --filter <text>             Run only checks whose ID contains this text (repeatable)
  --report json|junit         Report format (default json)
  --out <file>                Write the report here instead of stdout
  --engine-public-key <key>   The engine's Ed25519 public key (base64url), to check its engine ID
  --no-gateway                The API runs without the engine gateway; gateway checks skip
  --seed <n>                  Repeat a run's test data (the report records the seed)
  --timeout-ms <n>            Per check (default 120000)
```

The exit code is 0 only when no check failed, 1 when one did, and 2 for a usage error. Progress goes to stderr, one line per check. For an engine whose certificate comes from a development CA, pass the CA to Node with `NODE_EXTRA_CA_CERTS=<ca.pem>`.

## Starting the engine

`--engine-cmd` switches the CLI to the platform harness (`node/`, also exported as `@ptbk/conformance/node`). The harness starts the engine with the [launch contract](../../docs/engine-integration/identity-and-registration.md#launch-contract) and plays the platform around it. Every check gets a fresh engine, a fresh `PTBK_DATA_DIR` and its own fake servers on loopback, and everything is torn down after the check. When a check fails, the report carries the end of the engine's output (`engineOutput` in JSON, `<system-out>` in JUnit).

```sh
node packages/conformance/dist/ptbk-conformance.js \
  --engine-cmd "MOCK_SCENARIO=empty MOCK_HEARTBEAT_INTERVAL_S=2 node apps/mock-engine/dist/main.mjs" \
  --heartbeat-interval-s 2 --suite registration,heartbeat
```

The run's CA reaches the engine as `NODE_EXTRA_CA_CERTS`. It is ECDSA P-256, valid for a day, name-constrained to `localhost`, and its key never leaves the harness's memory. The command runs under `/bin/sh -c` in its own process group, and stopping sends SIGTERM to the group, then SIGKILL after 10 s. An exiting harness kills every group it started.

**Writing a platform suite** (C-09 tunnel, C-10 UI loader). A `PlatformCheck` is a `ConformanceCheck` whose context is a `PlatformCheckContext` ([platform.ts](node/harness/platform.ts)):

- `ctx.engine({ env })` returns an `EngineProcess`, not started yet, with a fresh empty data directory. Pass launch-contract variables such as `PTBK_RELAYS` in `env`. `start()`, `stop()`, `restart(patch)` (same data directory; `null` removes a variable), `waitForExit(ms)`, `running`, `exits` and `logs()` drive it.
- `startRegisteredEngine(ctx, { relays, env })` ([dashboard.ts](node/fakes/dashboard.ts)) starts a fake dashboard and an engine with a link code. It resolves once the engine has registered and sent its first accepted heartbeat, with `identity` (engine ID and public key). `restart(patch)` resolves at the next accepted heartbeat, which is the ready signal after a restart.
- `ctx.ca.issue(hostnames)` issues certificates the engine trusts. `createTestCa(name)` from [test-ca.ts](node/pki/test-ca.ts) makes an untrusted CA. `listenLoopback()` serves on 127.0.0.1 and ::1 with one port.
- `ctx.use(server)` closes a fake server after the check; `ctx.tempDir(label)` creates a private directory.
- `ctx.engineTarget(engine, { baseUrl, fetch })` gives a `ConformanceTarget` for an engine's API once a relay routes it, or `null` when the run has no session source. With `--engine-session-cmd` (and `--engine-ca-file` for the CA the engine's certificates chain to), `session()` runs the engine's [conformance-session command](../../docs/engine-integration/identity-and-registration.md#conformance-sessions) with the engine's environment. With `--mock-control`, each mock engine gets its own control listener, whose port stays the same across restarts. Both work again after a restart.
- `timeoutMs(expectations)` raises a check's timeout, for checks that wait for heartbeats.
- **Reaching the engine API through a relay** ([tunnel-relay.ts](node/tunnel/tunnel-relay.ts)): `startTunnelRelay(ctx)` starts a fake relay and gives the `env` (`PTBK_RELAYS`) to start the engine with; once it registered, `endpointFor(registered)` returns `{ baseUrl, fetch }` for `ctx.engineTarget`. The `fetch` opens a tunnel stream per request and runs TLS to the engine inside it, with SNI = `<engineId>.<engine domain>`, as a browser behind the relay would. It verifies the engine's certificate chain against `ctx.engineCertificateAuthority(engine)` (from the target factory's `certificateAuthority`; the mock's is its dev CA), and only its name and dates when there is none.

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
| `engine-api.activity.agent-names`                | Each activity item names its agent as `GET /agents/{agentId}` does (API 1.9), and an item without an agent names none                                                                          |
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
| `engine-api.cross-member.chat-writes`            | A member who may write in chats gets 403 or 404 sending or cancelling in a chat the owner started, and the chat is unchanged                                                                   |
| `engine-api.gateway.cross-site-refused`          | A state-changing request with `Sec-Fetch-Site: cross-site` is 403 even with a valid session; skips with `gateway: false`                                                                       |
| `registration.request.signature-verifies`        | The registration request is a strict `RegisterEngineRequest` within the size cap, with the given link code and `mode: tunnel`, and `verifyRegistration` accepts it                             |
| `registration.identity.engine-id-derived`        | The engine heartbeats as `deriveEngineId(enginePublicKey)`, in the path and the body                                                                                                           |
| `registration.identity.stable-across-restarts`   | After a restart: no new key registered, the same engine ID, an accepted heartbeat                                                                                                              |
| `registration.link-code.used-once`               | Restarted with the same environment, the engine sends the link code no second time                                                                                                             |
| `registration.secrets.never-logged`              | Neither the link code nor the engine key is in the engine's output, in any encoding; the link code is in no file under `PTBK_DATA_DIR`                                                         |
| `registration.response.unknown-fields-ignored`   | A registration answer with extra fields is accepted                                                                                                                                            |
| `registration.response.invalid-refused`          | Another engine ID, a hostname outside the engine domain or an oversized answer is refused: no heartbeat, nothing stored                                                                        |
| `registration.errors.invalid-link-code`          | 401 `invalid-link-code`: one attempt, the output names the code, nothing stored                                                                                                                |
| `registration.errors.engine-exists`              | 409 `engine-exists`: the same                                                                                                                                                                  |
| `registration.errors.engine-suspended`           | 403 `engine-suspended`: the same                                                                                                                                                               |
| `registration.errors.not-entitled`               | 403 `not-entitled`: the same                                                                                                                                                                   |
| `registration.errors.rate-limited`               | 429 `rate-limited`: at most three attempts in the watch window, the code named, nothing stored                                                                                                 |
| `registration.errors.unavailable`                | 503: the same                                                                                                                                                                                  |
| `registration.data-dir.private`                  | `PTBK_DATA_DIR` is created as a 0700 directory owned by the engine user                                                                                                                        |
| `registration.key-file.private`                  | The file holding the engine key is a regular file owned by the engine user, mode 0600                                                                                                          |
| `registration.key-file.loose-modes-refused`      | A 0755 data directory, a 0640 key file or a symlinked key: exit non-zero, no request, the path named                                                                                           |
| `heartbeat.signature.verifies`                   | The first beat goes to `heartbeatPath(engineId)` and `verifyHeartbeat` accepts it over the exact bytes                                                                                         |
| `heartbeat.body.strict`                          | Bodies within 4 KiB, strict `Heartbeat`, current `ts`, the registered `version`                                                                                                                |
| `heartbeat.seq.increasing-across-restarts`       | `seq` strictly increases, also across a restart                                                                                                                                                |
| `heartbeat.cadence.interval`                     | Beats every 60 s, no early retry after a 503; skips with `--heartbeat-interval-s` other than 60                                                                                                |
| `heartbeat.errors.keeps-sending`                 | After 429, 403, 404, 401 and `stale-timestamp` answers the engine keeps beating on the interval                                                                                                |
| `heartbeat.stale-ts.skew-shown`                  | The security panel, reached through the fake relay, shows the clock skew `stale-timestamp` answers report; skips without a session source                                                      |
| `tunnel.dial.websocket-upgrade`                  | The engine upgrades to a WebSocket on TUNNEL_PATH with the ptbk-tunnel subprotocol                                                                                                             |
| `tunnel.dial.every-relay`                        | Exactly one ready tunnel to every relay in the list; a relay that stalls holds up no other                                                                                                     |
| `tunnel.auth.signature-verifies`                 | auth is strict, names the engine's own ID and verifies with verifyTunnelAuth, in time                                                                                                          |
| `tunnel.auth.fresh-nonce`                        | Each connection's auth signs that connection's nonce and verifies against no other challenge                                                                                                   |
| `tunnel.auth.version-signed`                     | The auth signature verifies only over the version the engine sent                                                                                                                              |
| `tunnel.auth.list-encoding`                      | Unsorted version and feature lists in challenge still get an auth that C-02's verifyTunnelAuth accepts                                                                                         |
| `tunnel.stream.tls-through-tunnel`               | TLS 1.3 through a stream with the default hostname as SNI, then GET /api/v1/engine answers                                                                                                     |
| `tunnel.stream.unknown-sni-refused`              | A ClientHello for an unknown hostname or without SNI gets no certificate                                                                                                                       |
| `tunnel.stream.concurrent`                       | Many streams at once on one tunnel each complete TLS and an HTTP request                                                                                                                       |
| `tunnel.flow.send-window`                        | The engine never sends DATA beyond its credit and finishes once WINDOW grants more                                                                                                             |
| `tunnel.flow.grants-credit`                      | The engine grants WINDOW credit as it reads, so more than the initial window can reach it                                                                                                      |
| `tunnel.stream.close-handling`                   | The engine sends CLOSE when its side ends, and never sends on a stream the relay closed                                                                                                        |
| `tunnel.frames.ignorable-ignored`                | Frames with the ignorable flag and an unknown code are dropped; the tunnel and its streams carry on                                                                                            |
| `tunnel.frames.valid-from-engine`                | Every frame the engine sends is a v1 frame with at most MAX_FRAME_PAYLOAD_BYTES of payload                                                                                                     |
| `tunnel.liveness.ping`                           | A WebSocket ping at least every PING_INTERVAL_MS on a ready tunnel                                                                                                                             |
| `tunnel.auth.wrong-relay-refused`                | A challenge naming another relay gets no auth                                                                                                                                                  |
| `tunnel.negotiation.downgrade-refused`           | A ready with a lower version, a missing or an extra feature makes the engine close with PROTOCOL_ERROR                                                                                         |
| `tunnel.handshake.invalid-message-refused`       | An invalid challenge, a frame before ready or a text message after it closes with PROTOCOL_ERROR                                                                                               |
| `tunnel.frames.unknown-type-refused`             | An unknown frame code without the ignorable flag, or a v1 code with it, closes with PROTOCOL_ERROR                                                                                             |
| `tunnel.frames.malformed-refused`                | A malformed frame closes the tunnel with PROTOCOL_ERROR; the engine survives and reconnects                                                                                                    |
| `tunnel.frames.stream-id-rules`                  | A duplicate OPEN, a reused stream ID or a frame for a stream never opened closes with PROTOCOL_ERROR                                                                                           |
| `tunnel.dial.relay-certificate-verified`         | A relay certificate for another name, from an untrusted CA or expired gets no WebSocket upgrade                                                                                                |
| `tunnel.reconnect.after-close`                   | After SHUTTING_DOWN the engine is back soon; after any other close or a lost connection it reconnects                                                                                          |
| `tunnel.reconnect.relay-restart`                 | After a relay restart the tunnel is back within 10 s (plus a margin)                                                                                                                           |
| `tunnel.reconnect.after-reject`                  | Every reject reason, with its close code (1013 for rate-limited), is followed by a reconnect                                                                                                   |
| `tunnel.reconnect.backoff`                       | Consecutive failed attempts back off: no tight reconnect loop                                                                                                                                  |
| `tunnel.reconnect.replaced-no-loop`              | After REPLACED the engine does not reconnect in a loop                                                                                                                                         |
| `tunnel.proxy.connect`                           | HTTPS_PROXY tunnels through CONNECT with the relay certificate still verified; NO_PROXY bypasses it                                                                                            |
| `ui-loader.install.pinned-valid`                 | A valid regular release installs under `pinned`; the panel shows its version, archive SHA-256 and log index; it is served                                                                      |
| `ui-loader.serve.listed-files-only`              | Every manifest file is served byte for byte; an unlisted asset is 404; HTML navigations get the entry; the engine's reserved paths never do                                                    |
| `ui-loader.serve.security-headers`               | Entry, asset, fallback and 404 carry `ENGINE_UI_CSP` and the full header set, for a bundle whose manifest `csp` differs                                                                        |
| `ui-loader.signature.strict-ed25519`             | Release-key signatures over the PAE for each case class of `ed25519-vectors.json` get exactly the protocol's strict verdict                                                                    |
| `ui-loader.signature.threshold`                  | Release key alone, provenance alone, maintainers only and security releases short of 2 distinct maintainers are refused                                                                        |
| `ui-loader.dsse.pae-only`                        | A raw-payload signature, a payload changed after signing and another payload type are refused                                                                                                  |
| `ui-loader.entry.strict-payload`                 | A signed payload with a duplicate (also escaped) key or an unknown field is refused                                                                                                            |
| `ui-loader.provenance.exact-identity`            | Wrong repository, repository ID, workflow, tag, commit, ref, runner, trigger or issuer, a SAN with a prefix or suffix, and non-UTF8String extensions are refused                               |
| `ui-loader.provenance.log-required`              | No Rekor entry, no SCT or a CA outside the trusted root is refused                                                                                                                             |
| `ui-loader.artifact.hash-mismatch`               | An archive that differs from the entry's SHA-256 is refused                                                                                                                                    |
| `ui-loader.manifest.files-enforced`              | Unlisted, missing or changed files, a wrong size, and a manifest for another version or commit or with an unknown field are refused                                                            |
| `ui-loader.archive.unsafe-entries`               | `../`, absolute paths, symbolic and hard links are refused                                                                                                                                     |
| `ui-loader.manifest.engine-api-range`            | A bundle for another engine API major is refused                                                                                                                                               |
| `ui-loader.rollback.not-newer`                   | An older version, and the active version with other bytes, are not installed                                                                                                                   |
| `ui-loader.revocations.expired-keeps-current`    | An expired list keeps the current bundle (`revocations-unverifiable`, `expired`)                                                                                                               |
| `ui-loader.revocations.unverifiable`             | A missing list, an untrusted signer, a future `issuedAt` and an over-long validity keep the current bundle with the matching reason                                                            |
| `ui-loader.revocations.rollback-persisted`       | After a restart, a list older than the accepted one is `rolled-back`                                                                                                                           |
| `ui-loader.revocations.revoked-refused`          | A revoked candidate is refused                                                                                                                                                                 |
| `ui-loader.store.unavailable-keeps-current`      | A 503 record or an archive cut off halfway keeps the current bundle                                                                                                                            |
| `ui-loader.delay.trusted-time`                   | Under `auto`, `eligibleAt` is 72 h after the latest of `publishedAt`, the trusted time and first sight                                                                                         |
| `ui-loader.delay.first-seen-persisted`           | `eligibleAt` survives a restart                                                                                                                                                                |
| `ui-loader.policy.honoured`                      | `pinned` installs exactly its version, `auto` checks `latest.json`, `manual` installs nothing at startup                                                                                       |
| `ui-loader.revocations.revoked-current`          | A revoked active bundle stops being served, falling back to the previous one or to the plain engine page, also after a restart                                                                 |

Every `runs`, `files`, `triggers` and `integrations` check skips with reason `capability-not-advertised` when `GET /engine` does not list that capability; the permission checks cover every mutating route of each advertised capability.

### Audit expectations

The contract fixes the action names (`AUDIT_ACTIONS`); the suite expects each mutating route's entry to carry the action named for it and a target of the kind the route acts on, with the ID from its path or, for a create, the created resource. For example `PATCH /agents/{agentId}` is `agent.update` on the agent, `POST /chats/{chatId}/messages` is `chat.message.send` on the chat, `POST /chats/{chatId}/messages/{messageId}/cancel` is `chat.reply.cancel` on the message, and settings changes have no target. The full table is `AUDIT_EXPECTATIONS` in `src/suites/engine-api/audit.ts`.

## UI loader suite

The suite drives the engine through a lab (`node/suites/ui-loader/platform-lab.ts`), one per check: a registered engine from the harness, reached through an `EngineEndpoints` route (the relay), and a fake release store in the [mirror layout v1](../../docs/engine-integration/ui-loader.md#release-mirror-layout-v1) over HTTPS, and the engine restarted with `PTBK_UPDATE_POLICY`, `PTBK_PINNED_VERSION` and a `PTBK_CONFORMANCE_TRUST_FILE` for each scenario (the update check at startup is the trigger). Each run generates its release keys and an ephemeral test Sigstore (`src/suites/ui-loader/sigstore/`), so every release is signed on the fly and verified by the engine's real Sigstore adapter. It reads `GET /security` → `ui` with an owner session and fetches what the engine serves. Each refusal check also asserts that the previous bundle is still active and served. Versions within a run only increase (`1.0.<n>`).

The package tests run every check against an in-process fake loader built on `verifyRelease`, once correct and once per deliberate defect (`src/testing/ui-loader/fake-ui-lab.ts`), so each check is shown to pass and to fail.

## Against the mock engine (this repo)

The `conformance` CI job starts a relay and the mock engine on loopback (with `*.localhost` names and a fixed seed), runs the bundled CLI through the relay with `--mock-control-url` and uploads the JUnit report; a failing check fails the job. The mock target (`createMockEngineTarget`) gets sessions from the mock's dev-only control listener; the real engine never has that endpoint.

## Development

`bun run --filter @ptbk/conformance test` builds the bundle and the mock engine, and runs the self-test: the whole suite against an in-process engine built on `@ptbk/engine-api/in-memory` (which must pass every check), against deliberately broken variants of it (each must fail its matching check), and the bundled CLI against an engine over HTTP. The platform suites run against the mock engine and against [fake-engine.ts](node/testing/fake-engine.ts), a second, independent implementation in plain `node:crypto` whose `FAKE_ENGINE_DEFECTS` break one rule at a time; each check must fail for its defect.
