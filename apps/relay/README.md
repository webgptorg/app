# @ptbk/relay

SNI passthrough relay. Engines dial in over `wss://relay-<region>.<domain>/v1/tunnel` and keep a multiplexed tunnel open; browsers connect on 443 and the relay pipes their TLS bytes into the matching tunnel without decrypting them (spec, Relay and tunnel; Interfaces 3).

Runs on Node 24 on plain VPSs, several in parallel. Must never hold an engine key or terminate TLS for an engine hostname.

One TCP listener on `RELAY_LISTEN_PORT` reads the SNI of every connection: the relay's own hostname goes to the tunnel endpoint (the only place it terminates TLS), an engine's hostname is piped raw into that engine's tunnel, anything else is closed without a byte.

## Run

```sh
bun run --filter @ptbk/relay dev     # tsx watch, from source
bun run --filter @ptbk/relay build   # dist/main.mjs: one self-contained ESM file plus sourcemap
node apps/relay/dist/main.mjs        # needs no node_modules
docker build --file apps/relay/Dockerfile .   # the production image, from the repository root (I-03)
```

The image is that one file on Node 24 (base pinned by digest), running as uid 10001. `release-relay.yml` builds it with no cache and signs it, and the relay hosts pull it ([infra/relay](../../infra/relay/README.md#deploys)).

`SIGTERM` and `SIGINT` stop the relay gracefully: it stops accepting, closes every tunnel with `SHUTTING_DOWN` (4003) so engines reconnect to a peer relay at once, destroys sockets that have not closed after 2 s, then exits. `SIGHUP` reloads the static registry file (keeping the previous contents if the new file is invalid), expires the registry cache, loads the relay certificate and key into a fresh TLS context for new connections (open tunnels stay connected; unusable files are logged as `relay.certificate-rejected` and the old certificate stays), and runs a revalidation round, so a registry change takes effect at once. An uncaught exception or unhandled rejection is logged as `relay.crashed` with the error's name only, and the relay exits with 1 for systemd to restart it (I-01); it never continues in an unknown state. Logs are one JSON line per event on stdout and carry only the metadata the spec lists (Metadata we still see): no content, keys, tokens, file contents or browser hostnames. Every event and its fields are listed in `src/domain/log-events.ts`; the logger's types accept nothing else, the JSON logger drops any other field, and `test/log-allowlist.test.ts` fails if a list gains a browser IP, SNI, hostname or secret field or if the engine IP appears outside the tunnel events.

## Environment

Only `RELAY_*` and `LOG_LEVEL` are read; an unknown `RELAY_*` name is an error, and an empty value counts as unset. Errors name the setting, never its value. The limits' defaults are starting points: R-05 measures them and I-05 sets the production values.

| Variable                                  | Default             | Meaning                                                                                                                          |
| ----------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_HOSTNAME`                          | required            | The relay's own hostname: the only name it terminates TLS for, and its `relayId` (C-02); never the engine domain or under it     |
| `RELAY_LISTEN_HOST`                       | `0.0.0.0`           | IP address to listen on                                                                                                          |
| `RELAY_LISTEN_PORT`                       | `443`               | `0` picks a free port (tests)                                                                                                    |
| `RELAY_LISTEN_BACKLOG`                    | `511`               | Accept queue length (Node's default); the kernel caps it at `net.core.somaxconn`, so raise both together                         |
| `RELAY_ENGINE_DOMAIN`                     | required            | Engine default hostnames are `<engineId>.<engine domain>`                                                                        |
| `RELAY_TLS_CERT_FILE`                     | required            | Path to the relay's own certificate (PEM); refused if any DNS name or CN covers the engine domain or a name under it             |
| `RELAY_TLS_KEY_FILE`                      | required            | Path to the relay's own private key (PEM)                                                                                        |
| `RELAY_REGISTRY_KIND`                     | required            | `static` (a JSON file, local dev and e2e) or `http` (the dashboard's registry API, D-04)                                         |
| `RELAY_REGISTRY_FILE`                     | required for static | Path to the static registry file; not allowed with `http`                                                                        |
| `RELAY_REGISTRY_URL`                      | required for http   | Dashboard base URL: https (http only on 127.0.0.1, ::1, localhost), no credentials, query or fragment; not allowed with `static` |
| `RELAY_REGISTRY_TOKEN`                    | required for http   | Relay token, `ptbk_rt_` and 43 base64url characters; secret, never logged. Set this or `RELAY_REGISTRY_TOKEN_FILE`, never both   |
| `RELAY_REGISTRY_TOKEN_FILE`               | —                   | Path to a file holding the relay token (a trailing newline is ignored; at most 1 KiB), as systemd `LoadCredential` provides it   |
| `RELAY_REGISTRY_TIMEOUT_MS`               | `3000`              | A slower registry answer counts as a failure                                                                                     |
| `RELAY_REGISTRY_TTL_S`                    | `300`               | How long registry entries and CNAME answers are served from cache                                                                |
| `RELAY_REGISTRY_MAX_STALE_S`              | `86400`             | How long the last good entry or CNAME answers while the source fails; at most 86400, ≥ TTL                                       |
| `RELAY_DNS_SERVERS`                       | system resolvers    | Comma-separated IP addresses for the CNAME check                                                                                 |
| `RELAY_DNS_TIMEOUT_MS`                    | `3000`              | A slower DNS answer counts as an error                                                                                           |
| `RELAY_TUNNEL_HANDSHAKE_TIMEOUT_MS`       | `10000`             | From TCP accept to `ready`; a slower handshake gets `reject` `timeout` (or is dropped before the upgrade)                        |
| `RELAY_MAX_PENDING_HANDSHAKES`            | `1000`              | Connections between TCP accept and `ready`, relay-wide                                                                           |
| `RELAY_MAX_PENDING_HANDSHAKES_PER_IP`     | `10`                | The same per client IP                                                                                                           |
| `RELAY_MAX_TUNNELS_PER_IP`                | `50`                | Authenticated tunnels per client IP                                                                                              |
| `RELAY_TUNNEL_HANDSHAKES_PER_IP_PER_MIN`  | `60`                | Handshakes started per client IP per minute, also the burst; beyond it `rate-limited`                                            |
| `RELAY_REGISTRY_MISSES_PER_S`             | `20`                | Handshakes per second, relay-wide, whose engine is not in the registry cache (also the burst); beyond it `rate-limited`          |
| `RELAY_TUNNEL_FRAMES_PER_S`               | `20000`             | Frames from one engine per second, of any kind, also the burst; beyond it the tunnel closes with `FRAME_BUDGET`                  |
| `RELAY_TUNNEL_MIN_WINDOW_INCREMENT_BYTES` | `1024`              | Credit the relay collects before it sends DATA, unless the window was closed or the frame carries everything queued              |
| `RELAY_TUNNEL_PING_BUFFER_BYTES`          | `1048576`           | Bytes queued towards an engine above which a ping it sends is not answered and the tunnel is cut                                 |
| `RELAY_TUNNEL_MAX_BUFFERED_BYTES`         | `8388608`           | Bytes queued towards an engine that a send may not exceed; the tunnel is cut instead (at least 1 MiB)                            |
| `RELAY_CLIENT_HELLO_TIMEOUT_MS`           | `5000`              | From TCP accept until the ClientHello can be judged; a slower client is closed                                                   |
| `RELAY_CLIENT_HELLO_PRESSURE_TIMEOUT_MS`  | `1000`              | The same while more than 80% of the pending budget is taken                                                                      |
| `RELAY_MAX_CONNECTIONS`                   | `10000`             | Open connections on the listener, relay-wide (tunnels included)                                                                  |
| `RELAY_PENDING_CONNECTIONS_PERCENT`       | `25`                | Share of `RELAY_MAX_CONNECTIONS` for connections that have not sent a complete ClientHello (at least one connection)             |
| `RELAY_RESERVED_CONNECTIONS_PERCENT`      | `10`                | Share of `RELAY_MAX_CONNECTIONS` kept for the relay's own hostname: browsers never use it (0 to 50)                              |
| `RELAY_MAX_CONNECTIONS_PER_IP`            | `256`               | Open connections per IPv4 address and per IPv6 /64                                                                               |
| `RELAY_MAX_CONNECTIONS_PER_IPV6_56`       | `512`               | Open connections per IPv6 /56                                                                                                    |
| `RELAY_MAX_CONNECTIONS_PER_IPV6_48`       | `1024`              | Open connections per IPv6 /48                                                                                                    |
| `RELAY_NEW_CONNECTIONS_PER_IP_PER_S`      | `50`                | New connections per client IP (or /64) per second, also the burst                                                                |
| `RELAY_MAX_STREAMS_PER_ENGINE`            | `1024`              | Open browser streams per engine                                                                                                  |
| `RELAY_NEW_STREAMS_PER_ENGINE_PER_S`      | `200`               | New browser streams per engine per second, also the burst                                                                        |
| `RELAY_ENGINE_BANDWIDTH_BYTES_PER_S`      | `12500000`          | Bytes per second per engine, both directions together; one second's worth is the burst                                           |
| `RELAY_STREAM_FIRST_BYTE_TIMEOUT_MS`      | `10000`             | From `OPEN` until the engine's first byte; a silent stream is reset                                                              |
| `RELAY_STREAM_DRAIN_TIMEOUT_MS`           | `30000`             | After a browser's FIN, until its last bytes are within the engine's credit; then the stream is reset                             |
| `RELAY_STREAM_END_TIMEOUT_MS`             | `30000`             | After a stream ended, until its socket has flushed and closed; then the socket is destroyed                                      |
| `RELAY_MEMORY_BUDGET_BYTES`               | `1073741824`        | Bytes held for others, relay-wide (1 MiB to 8 GiB); sized for the 4 GB reference host until R-05 measures it                     |
| `RELAY_METRICS_TOKEN`                     | —                   | Metrics token, `ptbk_mt_` and 43 base64url characters; `GET /metrics` answers only it. Unset: no metrics endpoint (404)          |
| `RELAY_METRICS_TOKEN_FILE`                | —                   | Path to a file holding the metrics token, as for the registry token; never both                                                  |
| `RELAY_IMAGE_DIGEST`                      | —                   | `sha256:<64 hex>` of the image the host runs; `/healthz` reports it in `ptbk-relay-image` for the deploy pipeline (I-03)         |
| `LOG_LEVEL`                               | `info`              | `info`, `warn` or `error`                                                                                                        |

## Static registry file

For local development and e2e (X-01 generates it). Strict: unknown fields, duplicate engine IDs or another `v` refuse the file. Each engine is C-03's `RegistryEntry` plus its `engineId`:

```json
{
  "v": 1,
  "engines": [
    {
      "engineId": "<26 chars base32>",
      "enginePublicKey": "<Ed25519, base64url>",
      "hostnames": ["<engineId>.<engine domain>", "agents.customer.example"],
      "claims": [{ "hostname": "agents.customer.example", "sig": "<base64url Ed25519 over ptbk-hostname-v1>" }],
      "status": "active"
    }
  ]
}
```

A custom hostname routes only if its claim verifies and its CNAME points at exactly `<engineId>.<engine domain>` (ADR 0014).

## Dashboard registry

With `RELAY_REGISTRY_KIND=http` the relay reads `GET <RELAY_REGISTRY_URL>/internal/v1/engines/<engineId>` (C-03 Interface 2) with `Authorization: Bearer <RELAY_REGISTRY_TOKEN>`, one request per lookup, no redirects followed, within `RELAY_REGISTRY_TIMEOUT_MS`. The body (at most 64 KiB) is read tolerantly with C-03's `TolerantRegistryEntry`: known fields are validated, unknown ones from a newer dashboard are dropped. 200 is the entry, 404 an unknown engine; a timeout, a network error, any other status (5xx, 401/403 for a revoked or expired key, 429) and an invalid body are `unavailable`, logged as `registry.error` with the engine ID and the failure kind only. The adapter caches nothing and trusts nothing it reads: the cache below adds freshness and the stale window, the handshake checks that the engine ID derives from the entry's key and that this key signed the tunnel auth, and every custom hostname needs a verifying claim and a matching CNAME, so a compromised dashboard can deny service but cannot route one engine's hostname to another. Relay keys are minted per relay with the dashboard's `scripts/mint-relay-key.ts`.

## Registry and DNS caching

Every registry adapter is wrapped by `createCachedRegistry`: entries are fresh for `RELAY_REGISTRY_TTL_S`; when a refresh fails, times out or throws, the last entry answers while it is younger than `RELAY_REGISTRY_MAX_STALE_S` (logged as `registry.stale`), and after that the engine is `unavailable`, so a suspension takes effect within 24 hours even during a dashboard outage. `not-found` is cached for 30 seconds. Concurrent lookups for one engine share one request. CNAME answers follow the same rules (`dns.stale`), except that a definite answer (no record, another target) replaces a cached one at once.

## Tunnel endpoint

The relay terminates TLS here and nowhere else, with its own certificate: TLS 1.2 minimum, and for TLS 1.2 only ECDHE with AES-GCM or ChaCha20-Poly1305 (ADR 0014). `GET /v1/tunnel` with the `ptbk-tunnel` subprotocol upgrades to the tunnel WebSocket, `GET /healthz` answers `ok` (with the `ptbk-relay-image` header when `RELAY_IMAGE_DIGEST` is set: which signed image runs, nothing about engines), `GET /metrics` answers the metrics token (below), everything else is 404.

- **Handshake** (C-02): the relay sends `challenge` with a fresh 32-byte nonce and its versions and features; the engine answers `auth`; the relay looks the engine up in the cached registry, checks that the engine ID derives from the registry key, verifies the signature against the challenge it sent (strict Ed25519), then checks suspension and negotiates the version, and answers `ready` with the routable hostnames. Refusals map onto C-02's coarse reasons in `src/domain/tunnel/reject-mapping.ts`: unknown engine, bad signature, ID/key mismatch and registry outage all look like `auth-failed`; malformed input closes with `PROTOCOL_ERROR` and no `reject`.
- **Limits:** the handshake deadline counts from TCP accept (the listener passes its accept time on), so a slow ClientHello or TLS client spends it too; the pending-handshake limits count from the hand-off. A connection over a limit may finish TLS only to receive `reject` `rate-limited` and close code 1013; those connections have a pool as large as the limit, and beyond it sockets are dropped before TLS.
- **Sessions:** after `ready`, binary frames only. Only the relay opens streams; each direction has `WINDOW` credit, and an engine that sends beyond its credit, sends `OPEN`, names a stream that never existed or sends an invalid frame loses the whole tunnel (`PROTOCOL_ERROR`). A second tunnel of the same engine replaces the first (`REPLACED`). A hostname claimed by two connected engines routes to neither (`hostname.conflict`).
- **Handshake limits:** pending handshakes, tunnels and handshakes started per minute (`RELAY_TUNNEL_HANDSHAKES_PER_IP_PER_MIN`, so an engine cut for abuse cannot buy a signature check per reconnect) count per IPv4 address and per IPv6 /64. A refused handshake keeps its slot until its socket has closed, and the socket is destroyed 1 s after `reject`. Handshakes whose engine is not in the registry cache share a relay-wide budget (`RELAY_REGISTRY_MISSES_PER_S`, separate from revalidation); beyond it they get `rate-limited`, so a reconnect storm after a restart is paced, not locked out.
- **Revalidation:** every `RELAY_REGISTRY_TTL_S` each connected engine is looked up again past the cache (stale entries answer only while the registry fails), so a suspension takes effect within one TTL: suspended engines are closed with `SUSPENDED`, unknown ones, key mismatches and registry answers past the 24-hour stale window with `AUTH_FAILED`, and routable hostnames are recomputed.
- **Liveness:** a WebSocket ping with a random 8-byte payload every 25 s; a tunnel without a pong echoing it 10 s later is terminated. The relay answers the engine's pings itself, and stops answering (cutting the tunnel) once more than `RELAY_TUNNEL_PING_BUFFER_BYTES` is queued towards an engine that does not read.
- **Hostile engines:** every frame, ignorable ones and `CLOSE` for old streams included, spends the tunnel's frame budget (`RELAY_TUNNEL_FRAMES_PER_S`); `WINDOW` grants below `RELAY_TUNNEL_MIN_WINDOW_INCREMENT_BYTES` are collected before the relay sends DATA, unless they reopen a closed window, so 1-byte grants cannot buy 1-byte frames. A send that would queue more than `RELAY_TUNNEL_MAX_BUFFERED_BYTES` cuts the tunnel. `ws` holds at most one frame per message (128 fragments or buffered chunks) and waits 2 s for a close frame. A bug in a handler closes only its tunnel, with `PROTOCOL_ERROR`.

Logged: `tunnel.connected` and `tunnel.disconnected` (engine ID, engine IP, relay ID, close code), `tunnel.rejected` (the internal reason, engine IP and the claimed engine ID once `auth` parsed), `tunnel.revoked`, `tunnel.terminated` (the reason only), `tunnel.failed` (an error name). Never nonces, signatures, keys, engine versions, hostnames or payload bytes. Session tickets are off on the relay's own listener: tunnels live long, so resumption saves nothing, and ticket keys would never rotate.

## Browser listener

Every connection on `RELAY_LISTEN_PORT` is admitted against the per-source limits (per IPv4 address; per IPv6 /64, /56 and /48) and the global cap, then read until R-01's parser can judge its ClientHello (at most 32 KiB of handshake across its records, in at most 64 chunks, within `RELAY_CLIENT_HELLO_TIMEOUT_MS`). The parser keeps its place between chunks, so a ClientHello trickling in costs no more than one arriving whole. The SNI alone decides; ALPN is never read, so an ACME `acme-tls/1` validation reaches the engine like a browser.

- **Before the ClientHello**, connections share their own budget (`RELAY_PENDING_CONNECTIONS_PERCENT` of the cap). Above 80% of it the ClientHello timeout drops to `RELAY_CLIENT_HELLO_PRESSURE_TIMEOUT_MS`, and when it is full (or the whole cap is) a new connection evicts the oldest pending one instead of being refused, so a browser that sends its ClientHello promptly gets through a flood of idle connections.
- **The reserve** (`RELAY_RESERVED_CONNECTIONS_PERCENT` of the cap) is for the relay's own hostname: every connection is admitted against the whole cap, and once its SNI names an engine it must fit in the cap minus the reserve, so engines can always reconnect.
- **Memory:** every byte held for others counts against `RELAY_MEMORY_BUDGET_BYTES`: ClientHellos being read, frames queued towards engines, and each open stream's reservation, its whole window towards the browser plus one read towards the engine (320 KiB), which is the most it can come to hold. A new browser stream that does not fit is refused (`memory-limit`); while frames push the budget over, browsers are not read. Because streams are charged their reservation, browsers that stop reading fill the budget only with their own windows and never hold back browsers that read.

- **Own hostname:** the bytes read so far are put back and the socket goes to the tunnel endpoint.
- **Engine hostname** (a connected engine's default hostname, or a custom one whose claim and CNAME checked out): the per-engine stream limits apply, the relay opens a stream with the browser's address in `OPEN`, sends everything it read (the ClientHello and anything after it) as the first `DATA`, and from then on pipes bytes it cannot read. It holds no engine key or certificate; TLS ends on the engine.
- **Anything else** (no SNI, not a ClientHello, too large, too slow, an unknown or conflicting hostname, an engine without a tunnel here, a limit reached): the socket is destroyed without a byte written, so the relay never answers as a TLS endpoint for an engine's name.

Flow control keeps memory per stream bounded. Towards the engine, a browser socket is read one chunk at a time and only while the stream has credit; the streams of one tunnel take turns in 16 KiB slices, and all of them stop while the tunnel's WebSocket holds more than 512 KiB, until it drains below 128 KiB. Towards the browser, credit goes back to the engine only once the socket has flushed the bytes, so a browser that stops reading costs at most one window (256 KiB). The engine's bandwidth budget delays both. Streams have no idle timeout (SSE and WebSockets live long); TCP keepalive finds vanished browsers, and a tunnel that closes takes its browser sockets with it. Every other wait is bounded: a stream whose engine sends nothing within `RELAY_STREAM_FIRST_BYTE_TIMEOUT_MS` of `OPEN` is reset (so idle ClientHellos cannot fill an engine's stream slots); after a browser's FIN, bytes still waiting for credit get `RELAY_STREAM_DRAIN_TIMEOUT_MS`; after the engine's `CLOSE` the relay drops whatever the browser still sends and destroys the socket after `RELAY_STREAM_END_TIMEOUT_MS`. A connection keeps its admission until its stream has ended and its socket has closed.

Fairness between engines is proven by `test/fairness.test.ts` (I-05): one engine flooded with browsers and data, or a hostile engine flooding frames and reconnecting each time it is cut, while another engine's median connection latency stays within 2x its baseline. It compares wall-clock latencies on real time, so the `test` script runs it alone and without coverage after the other files, and retries a failed run twice. R-05 measures the production values on the reference host.

Nothing is logged per connection (spec: no access logs). In memory, for I-04: refusals per reason (never the SNI or IP), stream resets and tunnel terminations per reason, bytes in and out per engine per UTC day (today and yesterday), open and pending connections, bytes held and the memory budget's use. Accept errors on the listener (`EMFILE`) are logged as `relay.accept-failed`; Node's own connection cap is twice `RELAY_MAX_CONNECTIONS`, a backstop only.

## Metrics

`GET /metrics` on the relay's own hostname (ADR 0008) answers `Authorization: Bearer <RELAY_METRICS_TOKEN>` with the Prometheus text format, and 401 to anything else; the token is compared in constant time and is not the registry token. The dashboard scrapes it every minute (I-04, ADR 0012). Every series is declared in `src/domain/metrics/catalog.ts` with closed label lists, so the set of series is fixed at start and never names an engine, a hostname, an address or an account; `src/domain/metrics/catalog.test.ts` is the label-cardinality test, and `bun run --filter @ptbk/relay check:metrics` runs `promtool check metrics` over a real scrape (Docker).

| Series                                                                                                | Type      | Labels                                                                           |
| ----------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------- |
| `ptbk_relay_tunnels_active`                                                                           | gauge     |                                                                                  |
| `ptbk_relay_tunnel_connects_total`                                                                    | counter   |                                                                                  |
| `ptbk_relay_tunnel_disconnects_total`                                                                 | counter   | `code`: the close code's name (`replaced`, `shutting-down`, …, `other`)          |
| `ptbk_relay_tunnel_handshake_failures_total`                                                          | counter   | `reason`: the internal handshake failure (`bad-signature`, `timeout`, …)         |
| `ptbk_relay_tunnel_terminations_total`                                                                | counter   | `reason`: why the relay cut a tunnel itself                                      |
| `ptbk_relay_browser_connections_active`, `…_pending`                                                  | gauge     |                                                                                  |
| `ptbk_relay_browser_connections_total`                                                                | counter   | `outcome`: `routed`, `own-hostname`, `unknown-sni`, `no-sni`, `invalid`, `limit` |
| `ptbk_relay_browser_refusals_total`                                                                   | counter   | `reason`: the refusal reason behind `unknown-sni`, `invalid` and `limit`         |
| `ptbk_relay_stream_resets_total`                                                                      | counter   | `reason`                                                                         |
| `ptbk_relay_bytes_total`                                                                              | counter   | `direction`: `in` (towards engines) or `out`; all engines together               |
| `ptbk_relay_stream_open_seconds`                                                                      | histogram | From a ClientHello to the engine's first byte on the new stream                  |
| `ptbk_relay_registry_lookups_total`                                                                   | counter   | `result`: `fresh` (cache), `miss` (source answered), `stale`, `error`            |
| `ptbk_relay_registry_source_seconds`                                                                  | histogram | The registry source's latency, timeouts included                                 |
| `ptbk_relay_memory_budget_used_bytes`                                                                 | gauge     |                                                                                  |
| `ptbk_relay_process_resident_memory_bytes`, `…_heap_used_bytes`, `…_open_fds`, `…_start_time_seconds` | gauge     |                                                                                  |
| `ptbk_relay_event_loop_lag_seconds`                                                                   | gauge     | Largest event loop delay since the previous scrape                               |
| `ptbk_relay_certificate_expiry_timestamp_seconds`                                                     | gauge     | The relay's own certificate; updated on SIGHUP                                   |

Bytes per engine are added up per UTC day in memory only, for abuse handling, and dropped at midnight; they are never logged or exported.
