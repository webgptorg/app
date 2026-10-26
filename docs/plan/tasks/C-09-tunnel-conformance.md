# C-09. Tunnel conformance suite: a fake relay the engine dials

- **Lane:** Contracts · **Module:** `packages/conformance` (`node/`) · **Milestone:** M5
- **Depends on:** C-02, C-05, M-01, M-02
- **Status:** done (#85)
- **Spec:** Interfaces (draft) 3. Tunnel protocol, Relay and tunnel; ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md), [0010](../../adr/0010-protocol-design-principles.md), [0014](../../adr/0014-cryptography.md)

## Goal

The `tunnel` suite acts as the relays the engine dials and checks the engine's tunnel client against C-02's contract: handshake signing, negotiation, reject and close handling, reconnects, frames, flow control, TLS ended by the engine inside a stream, liveness and the proxy. It is the executable definition of done for the real engine's tunnel client.

## Context

C-05 registered three tunnel check IDs as `skip`. C-08's platform harness (merged in #87; the rest of C-08 does not block this task) for each check spawns the engine under test, registers it with a fake dashboard and hands the check a test CA the engine trusts through `NODE_EXTRA_CA_CERTS`. This task builds on that harness with a fake relay inside the conformance package. No app is spawned or imported; the relay in `apps/relay` and the mock engine's tunnel client serve only as reference implementations. Where the spec's Interface 3 differs from the contract code in `@ptbk/protocol`, the code wins (tunnel-client.md says so).

Other suites need to reach the engine API on the engine's own origin in harness runs: C-10's UI loader checks, the engine API suite and C-08's heartbeat skew check. They get it through this task's relay, as a `fetch` whose requests run as a real TLS client through a tunnel stream.

## Scope

- `node/fake-relay/`:
  - One TLS listener on loopback (IPv4 and IPv6) that serves every relay hostname by SNI. The certificate comes from the harness CA, or is deliberately bad: another name, an untrusted CA or expired.
  - WebSockets on `TUNNEL_PATH`.
  - `RelayConnection`, which records events, pings and close codes.
  - `RelayTunnel`, which decodes and judges the frames the engine sends, and exposes streams as Node `Duplex` objects with both `WINDOW` directions accounted for.
  - A small `CONNECT` proxy for the proxy check.
- `node/tunnel/runtime.ts`: the relay side of one check. By default every relay accepts the engine as an honest relay would (challenge, `verifyTunnelAuth` against the registration's key, `negotiateTunnel`, `ready`) and keeps its tunnel ready. A check takes one relay into manual mode to script the next connections.
- `node/tunnel/tunnel-relay.ts`: `startTunnelRelay(ctx, { relays? })` → `{ env, endpointFor(registered), runtime, relay }`. `env` sets `PTBK_RELAYS` to the relays. `endpointFor` returns `{ baseUrl: https://<engineId>.<engine domain>, fetch }`, the endpoint port for other suites (agreed with C-10 on #86).
- `node/tunnel/engine-fetch.ts`: that `fetch`.
  - It opens a new tunnel stream per request, runs TLS with SNI = the engine hostname and ALPN `http/1.1`, and speaks `node:http` over it. Bodies stream (SSE works), and requests can be aborted.
  - It verifies the engine's certificate chain against `ctx.engineCertificateAuthority(engine)`, a new optional hook on C-08's `EngineTargetFactory`. The mock factory reads `<dataDir>/dev-ca/ca-cert.pem`. Without a trust anchor it checks the name and the dates only.
- `node/suites/tunnel/`: the 28 checks below as a `PlatformSuite` in `PLATFORM_SUITES`.
  - Each check gets its own fake relay with three relay hostnames, and a registered engine whose `PTBK_RELAYS` names them.
  - Before scripting anything, it waits until every relay has a ready tunnel.
  - `src/suites/tunnel` goes away; the IDs keep their names.
- Docs: checklist.md (every ID), conformance.md (status row), tunnel-client.md (the conformance section, what the engine must support, the trade-offs) and the package README.

## Checks

| ID                                         | Requirement                                                                                                                                                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tunnel.dial.websocket-upgrade`            | Upgrade on `TUNNEL_PATH` offering `ptbk-tunnel`; no other request reaches the relay                                                                                                                                                               |
| `tunnel.dial.every-relay`                  | Exactly one ready tunnel per relay in `PTBK_RELAYS`; a relay that stalls before its challenge holds up no other relay                                                                                                                             |
| `tunnel.dial.relay-certificate-verified`   | A relay certificate for another name, from an untrusted CA or expired: the engine dials (the relay sees its ClientHello) but never sends an HTTP byte                                                                                             |
| `tunnel.auth.signature-verifies`           | `auth` is strict, comes within `AUTH_TIMEOUT_MS`, names the key's engine ID and verifies with `verifyTunnelAuth` against the challenge sent                                                                                                       |
| `tunnel.auth.fresh-nonce`                  | A second connection's `auth` signs its own nonce, never the first one's (a cached `auth` fails)                                                                                                                                                   |
| `tunnel.auth.version-signed`               | (C-05) The signature verifies over the `version` the engine sent; an engine that leaves it out is named as such                                                                                                                                   |
| `tunnel.auth.list-encoding`                | (C-05) A challenge with `[10, 2, 1]` and features that sort differently by byte and by locale gets an `auth` that verifies, and the engine accepts the honest `ready`; a wrong encoding is named                                                  |
| `tunnel.auth.wrong-relay-refused`          | A challenge naming another relay gets no `auth`, and the engine closes                                                                                                                                                                            |
| `tunnel.negotiation.downgrade-refused`     | (C-05) A `ready` with a version other than the negotiated one (a lower one when the engine offers two), an extra feature, or a missing one (when the engine offers features) closes with `PROTOCOL_ERROR`                                         |
| `tunnel.handshake.invalid-message-refused` | A challenge with an unknown field, a `ready` before any challenge, a frame before `ready` and text after it each close with `PROTOCOL_ERROR`                                                                                                      |
| `tunnel.stream.tls-through-tunnel`         | `OPEN`, then TLS 1.3 with SNI = the default hostname and a certificate valid for it (chain checked when the trust anchor is known); `GET /api/v1/engine` answers with `engineId` given a session, and with the contract's 401 problem without one |
| `tunnel.stream.unknown-sni-refused`        | Another hostname or no SNI gets no certificate; the tunnel survives                                                                                                                                                                               |
| `tunnel.stream.concurrent`                 | 24 streams at once each complete TLS and a request                                                                                                                                                                                                |
| `tunnel.flow.send-window`                  | Without `WINDOW`, the engine stops at its credit (sequential requests until an answer stalls with the credit used up; a slow answer with credit left is waited for); after a grant the half-sent answer completes                                 |
| `tunnel.flow.grants-credit`                | Requests totalling 2.5 windows reach the engine: it grants credit as it reads                                                                                                                                                                     |
| `tunnel.stream.close-handling`             | The engine sends `CLOSE` when its side ends (`Connection: close`); after the relay's `CLOSE` it sends no more `DATA`, even when a late `WINDOW` for that stream arrives, and keeps the tunnel                                                     |
| `tunnel.frames.ignorable-ignored`          | Ignorable unknown codes (on a live stream, on stream 0, on a stream never opened) are dropped, and the stream still answers                                                                                                                       |
| `tunnel.frames.valid-from-engine`          | Every frame the engine sent during the check decodes as v1 within `MAX_FRAME_PAYLOAD_BYTES`. No `OPEN`, no frame for a stream never opened, no grant past `MAX_WINDOW_BYTES`, no ignorable frame, no text after `ready`                           |
| `tunnel.frames.unknown-type-refused`       | Code 5 without the flag, `DATA` with the flag and code 0 with the flag each close with `PROTOCOL_ERROR`, and the engine reconnects                                                                                                                |
| `tunnel.frames.malformed-refused`          | A frame shorter than its header, a zero `WINDOW`, `DATA` one byte too large (1009 is also accepted) and an `OPEN` with a bad family each close with `PROTOCOL_ERROR`; the engine survives and reconnects                                          |
| `tunnel.frames.stream-id-rules`            | A duplicate `OPEN`, an `OPEN` reusing a closed ID and `DATA` for a stream never opened each close with `PROTOCOL_ERROR`                                                                                                                           |
| `tunnel.reconnect.after-close`             | After `SHUTTING_DOWN` the engine is back within 5 s; after `AUTH_FAILED`, `SUSPENDED`, `PROTOCOL_ERROR`, `FRAME_BUDGET` and a lost connection, within 30 s                                                                                        |
| `tunnel.reconnect.relay-restart`           | With the relays down for 1 s (TCP refused), every tunnel is back within 15 s                                                                                                                                                                      |
| `tunnel.reconnect.after-reject`            | After each reject reason with its close code (1013 for `rate-limited`), nothing more comes on that socket, then a reconnect                                                                                                                       |
| `tunnel.reconnect.backoff`                 | After five consecutive failed attempts (rejects, a close before the challenge, a dropped connection), the engine's own reconnect delays add up to at least 1 s                                                                                    |
| `tunnel.reconnect.replaced-no-loop`        | After `REPLACED`, repeated on each reconnect, at most one reconnect within 10 s                                                                                                                                                                   |
| `tunnel.liveness.ping`                     | A WebSocket ping within `PING_INTERVAL_MS` + 10 s of `ready`                                                                                                                                                                                      |
| `tunnel.proxy.connect`                     | With `HTTPS_PROXY` (basic auth), every tunnel except the `NO_PROXY` relay goes through `CONNECT` with the credentials; a wrong-name relay certificate through the proxy gets no upgrade; the password never appears in the engine's output        |

## Out of scope

- The relay's own rules (R-03, R-04), which the relay's tests cover.
- Registration and heartbeat (C-08), and the UI loader (C-10).
- Custom hostname claims, which have no reference implementation yet.
- ACME issuance through the relay (M-03's e2e scenario).

## Design notes

- **Timing.** The defaults are the contract plus tolerance (`CONTRACT_TIMING`). The self-test shortens them only for its in-process fake engine. Under full jitter a single reconnect may legitimately come at once, so `backoff` judges five delays together, each measured from the closed connection to the engine's next TCP connection, so the relay's own work and a busy machine never shorten them. The 1 s threshold fails a tight loop, and a correct engine with the mock's parameters falls under it with a probability below 3 × 10⁻⁴.
- **No HTTP pipelining.** Browsers never pipeline. Node's HTTP server over TLS on a JS stream also drops a pipelined connection when its output backs up (`HPE_PAUSED`). So the flow checks send their requests one after another on one keep-alive connection.
- **Ping.** The check measures only the first interval after `ready`; a second interval would add 25 s per run.
- **The engine's TLS certificate.** The suite always checks the name, the dates and TLS 1.3, and also the chain when the engine's target factory names a trust anchor. The engine needs nothing special: it serves the certificate it would serve anyway (ACME in production, its development CA under test). A conformance run never asks it to accept a CA override for anything it verifies.

## Acceptance criteria

- [x] All 28 checks pass against the mock engine through the harness (`node/suites/tunnel/mock-engine.test.ts`) and in the CI conformance job's platform step.
- [x] Every check passes against an in-process correct engine and fails for each of its defects (`node/tunnel/checks/checks.test.ts`).
- [x] The endpoint port reaches the mock's engine API with a session, verifying the chain against the mock's dev CA.
- [x] The package's coverage stays at or above 90% for lines and branches.
- [x] Every check ID is in checklist.md; conformance.md and tunnel-client.md describe the suite.
- [x] `bun run check` passes.
- [x] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- `PTBK_RELAYS` overrides the registration's relays (C-08 made it a launch-contract variable). The suite depends on it to point the engine at loopback relays on a random port.
- **Late frames for a closed stream.** tunnel-client.md says such a frame "may be dropped". The suite fails an engine that closes the whole tunnel over one, because relays routinely have frames in flight when a stream closes. Recommended: tunnel-client.md says "must be dropped".
- An oversized frame that the WebSocket layer closes with 1009, instead of `PROTOCOL_ERROR`, is accepted.
- Missing-feature downgrades can only be tested once engines offer features; v1 defines none.
