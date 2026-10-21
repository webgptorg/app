# @ptbk/relay

SNI passthrough relay. Engines dial in over `wss://relay-<region>.<domain>/v1/tunnel` and keep a multiplexed tunnel open; browsers connect on 443 and the relay pipes their TLS bytes into the matching tunnel without decrypting them (spec, Relay and tunnel; Interfaces 3).

Runs on Node 24 on plain VPSs, several in parallel. Must never hold an engine key or terminate TLS for an engine hostname.

One TCP listener on `RELAY_LISTEN_PORT` reads the SNI of every connection: the relay's own hostname goes to the tunnel endpoint (the only place it terminates TLS), an engine's hostname is piped raw into that engine's tunnel, anything else is closed without a byte.

## Run

```sh
bun run --filter @ptbk/relay dev     # tsx watch, from source
bun run --filter @ptbk/relay build   # dist/main.mjs: one self-contained ESM file plus sourcemap
node apps/relay/dist/main.mjs        # needs no node_modules
```

`SIGTERM` and `SIGINT` stop the relay gracefully: it stops accepting, closes every tunnel with `SHUTTING_DOWN` (4003) so engines reconnect to a peer relay at once, destroys sockets that have not closed after 2 s, then exits; `SIGHUP` reloads the static registry file, keeping the previous contents if the new file is invalid. Logs are one JSON line per event on stdout and carry only the metadata the spec lists (Metadata we still see): no content, keys, tokens, file contents or browser hostnames.

## Environment

Only `RELAY_*` and `LOG_LEVEL` are read; an unknown `RELAY_*` name is an error, and an empty value counts as unset. Errors name the setting, never its value.

| Variable                              | Default             | Meaning                                                                                                                          |
| ------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_HOSTNAME`                      | required            | The relay's own hostname: the only name it terminates TLS for, and its `relayId` (C-02)                                          |
| `RELAY_LISTEN_HOST`                   | `0.0.0.0`           | IP address to listen on                                                                                                          |
| `RELAY_LISTEN_PORT`                   | `443`               | `0` picks a free port (tests)                                                                                                    |
| `RELAY_ENGINE_DOMAIN`                 | required            | Engine default hostnames are `<engineId>.<engine domain>`                                                                        |
| `RELAY_TLS_CERT_FILE`                 | required            | Path to the relay's own certificate (PEM)                                                                                        |
| `RELAY_TLS_KEY_FILE`                  | required            | Path to the relay's own private key (PEM)                                                                                        |
| `RELAY_REGISTRY_KIND`                 | required            | `static` (a JSON file, local dev and e2e) or `http` (the dashboard's registry API, D-04)                                         |
| `RELAY_REGISTRY_FILE`                 | required for static | Path to the static registry file; not allowed with `http`                                                                        |
| `RELAY_REGISTRY_URL`                  | required for http   | Dashboard base URL: https (http only on 127.0.0.1, ::1, localhost), no credentials, query or fragment; not allowed with `static` |
| `RELAY_REGISTRY_TOKEN`                | required for http   | Relay token, `ptbk_rt_` and 43 base64url characters; secret, never logged                                                        |
| `RELAY_REGISTRY_TIMEOUT_MS`           | `3000`              | A slower registry answer counts as a failure                                                                                     |
| `RELAY_REGISTRY_TTL_S`                | `300`               | How long registry entries and CNAME answers are served from cache                                                                |
| `RELAY_REGISTRY_MAX_STALE_S`          | `86400`             | How long the last good entry or CNAME answers while the source fails; at most 86400, ≥ TTL                                       |
| `RELAY_DNS_SERVERS`                   | system resolvers    | Comma-separated IP addresses for the CNAME check                                                                                 |
| `RELAY_DNS_TIMEOUT_MS`                | `3000`              | A slower DNS answer counts as an error                                                                                           |
| `RELAY_TUNNEL_HANDSHAKE_TIMEOUT_MS`   | `10000`             | From TCP accept to `ready`; a slower handshake gets `reject` `timeout` (or is dropped before the upgrade)                        |
| `RELAY_MAX_PENDING_HANDSHAKES`        | `1000`              | Connections between TCP accept and `ready`, relay-wide                                                                           |
| `RELAY_MAX_PENDING_HANDSHAKES_PER_IP` | `10`                | The same per client IP                                                                                                           |
| `RELAY_MAX_TUNNELS_PER_IP`            | `50`                | Authenticated tunnels per client IP                                                                                              |
| `RELAY_CLIENT_HELLO_TIMEOUT_MS`       | `5000`              | From TCP accept until the ClientHello can be judged; a slower client is closed                                                   |
| `RELAY_MAX_CONNECTIONS`               | `10000`             | Open connections on the listener, relay-wide (tunnels included)                                                                  |
| `RELAY_MAX_CONNECTIONS_PER_IP`        | `256`               | The same per client IP; IPv6 counts per /64                                                                                      |
| `RELAY_NEW_CONNECTIONS_PER_IP_PER_S`  | `50`                | New connections per client IP (or /64) per second, also the burst                                                                |
| `RELAY_MAX_STREAMS_PER_ENGINE`        | `1024`              | Open browser streams per engine                                                                                                  |
| `RELAY_NEW_STREAMS_PER_ENGINE_PER_S`  | `200`               | New browser streams per engine per second, also the burst                                                                        |
| `RELAY_ENGINE_BANDWIDTH_BYTES_PER_S`  | `12500000`          | Bytes per second per engine, both directions together; one second's worth is the burst                                           |
| `LOG_LEVEL`                           | `info`              | `info`, `warn` or `error`                                                                                                        |

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

The relay terminates TLS here and nowhere else, with its own certificate: TLS 1.2 minimum, and for TLS 1.2 only ECDHE with AES-GCM or ChaCha20-Poly1305 (ADR 0014). `GET /v1/tunnel` with the `ptbk-tunnel` subprotocol upgrades to the tunnel WebSocket, `GET /healthz` answers `ok`, everything else is 404.

- **Handshake** (C-02): the relay sends `challenge` with a fresh 32-byte nonce and its versions and features; the engine answers `auth`; the relay looks the engine up in the cached registry, checks that the engine ID derives from the registry key, verifies the signature against the challenge it sent (strict Ed25519), then checks suspension and negotiates the version, and answers `ready` with the routable hostnames. Refusals map onto C-02's coarse reasons in `src/domain/tunnel/reject-mapping.ts`: unknown engine, bad signature, ID/key mismatch and registry outage all look like `auth-failed`; malformed input closes with `PROTOCOL_ERROR` and no `reject`.
- **Limits:** the handshake deadline counts from TCP accept (the listener passes its accept time on), so a slow ClientHello or TLS client spends it too; the pending-handshake limits count from the hand-off. A connection over a limit may finish TLS only to receive `reject` `rate-limited` and close code 1013; those connections have a pool as large as the limit, and beyond it sockets are dropped before TLS.
- **Sessions:** after `ready`, binary frames only. Only the relay opens streams; each direction has `WINDOW` credit, and an engine that sends beyond its credit, sends `OPEN`, names a stream that never existed or sends an invalid frame loses the whole tunnel (`PROTOCOL_ERROR`). A second tunnel of the same engine replaces the first (`REPLACED`). A hostname claimed by two connected engines routes to neither (`hostname.conflict`).
- **Revalidation:** every `RELAY_REGISTRY_TTL_S` each connected engine is looked up again: suspended engines are closed with `SUSPENDED`, unknown ones, key mismatches and registry answers past the 24-hour stale window with `AUTH_FAILED`, and routable hostnames are recomputed.
- **Liveness:** a WebSocket ping every 25 s; a tunnel without a pong 10 s later is terminated.

Logged: `tunnel.connected` and `tunnel.disconnected` (engine ID, engine IP, relay ID, close code), `tunnel.rejected` (the internal reason, engine IP and the claimed engine ID once `auth` parsed), `tunnel.revoked`. Never nonces, signatures, keys, engine versions, hostnames or payload bytes.

## Browser listener

Every connection on `RELAY_LISTEN_PORT` is admitted against the per-IP and global limits, then read until R-01's parser can judge its ClientHello (at most 16 KiB, within `RELAY_CLIENT_HELLO_TIMEOUT_MS`). The SNI alone decides; ALPN is never read, so an ACME `acme-tls/1` validation reaches the engine like a browser.

- **Own hostname:** the bytes read so far are put back and the socket goes to the tunnel endpoint.
- **Engine hostname** (a connected engine's default hostname, or a custom one whose claim and CNAME checked out): the per-engine stream limits apply, the relay opens a stream with the browser's address in `OPEN`, sends everything it read (the ClientHello and anything after it) as the first `DATA`, and from then on pipes bytes it cannot read. It holds no engine key or certificate; TLS ends on the engine.
- **Anything else** (no SNI, not a ClientHello, too large, too slow, an unknown or conflicting hostname, an engine without a tunnel here, a limit reached): the socket is destroyed without a byte written, so the relay never answers as a TLS endpoint for an engine's name.

Flow control keeps memory per stream bounded. Towards the engine, a browser socket is read one chunk at a time and only while the stream has credit; the streams of one tunnel take turns in 16 KiB slices, and all of them stop while the tunnel's WebSocket holds more than 512 KiB, until it drains below 128 KiB. Towards the browser, credit goes back to the engine only once the socket has flushed the bytes, so a browser that stops reading costs at most one window (256 KiB). The engine's bandwidth budget delays both. Streams have no idle timeout (SSE and WebSockets live long); TCP keepalive finds vanished browsers, and a tunnel that closes takes its browser sockets with it.

Nothing is logged per connection (spec: no access logs). In memory, for I-04: refusals per reason (never the SNI or IP), bytes in and out per engine per UTC day (today and yesterday), open connections and bytes held.
