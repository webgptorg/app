# @ptbk/relay

SNI passthrough relay. Engines dial in over `wss://relay-<region>.<domain>/v1/tunnel` and keep a multiplexed tunnel open; browsers connect on 443 and the relay pipes their TLS bytes into the matching tunnel without decrypting them (spec, Relay and tunnel; Interfaces 3).

Runs on Node 24 on plain VPSs, several in parallel. Must never hold an engine key or terminate TLS for an engine hostname.

So far: configuration, ports, the cached registry, the CNAME check for custom hostnames and the static registry. The tunnel endpoint (R-03) and the browser listener (R-04) plug into `src/app/start-relay.ts`.

## Run

```sh
bun run --filter @ptbk/relay dev     # tsx watch, from source
bun run --filter @ptbk/relay build   # dist/main.mjs: one self-contained ESM file plus sourcemap
node apps/relay/dist/main.mjs        # needs no node_modules
```

`SIGTERM` and `SIGINT` stop the relay gracefully; `SIGHUP` reloads the static registry file, keeping the previous contents if the new file is invalid. Logs are one JSON line per event on stdout and carry only the metadata the spec lists (Metadata we still see): no content, keys, tokens, file contents or browser hostnames.

## Environment

Only `RELAY_*` and `LOG_LEVEL` are read; an unknown `RELAY_*` name is an error, and an empty value counts as unset. Errors name the setting, never its value.

| Variable                     | Default             | Meaning                                                                                                                          |
| ---------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `RELAY_HOSTNAME`             | required            | The relay's own hostname: the only name it terminates TLS for, and its `relayId` (C-02)                                          |
| `RELAY_LISTEN_HOST`          | `0.0.0.0`           | IP address to listen on                                                                                                          |
| `RELAY_LISTEN_PORT`          | `443`               | `0` picks a free port (tests)                                                                                                    |
| `RELAY_ENGINE_DOMAIN`        | required            | Engine default hostnames are `<engineId>.<engine domain>`                                                                        |
| `RELAY_TLS_CERT_FILE`        | required            | Path to the relay's own certificate (PEM)                                                                                        |
| `RELAY_TLS_KEY_FILE`         | required            | Path to the relay's own private key (PEM)                                                                                        |
| `RELAY_REGISTRY_KIND`        | required            | `static` (a JSON file) or `http` (the dashboard, D-04; refused until that adapter exists)                                        |
| `RELAY_REGISTRY_FILE`        | required for static | Path to the static registry file; not allowed with `http`                                                                        |
| `RELAY_REGISTRY_URL`         | required for http   | Dashboard base URL: https (http only on 127.0.0.1, ::1, localhost), no credentials, query or fragment; not allowed with `static` |
| `RELAY_REGISTRY_TOKEN`       | required for http   | Relay token, `ptbk_rt_` and 43 base64url characters; secret, never logged                                                        |
| `RELAY_REGISTRY_TIMEOUT_MS`  | `3000`              | A slower registry answer counts as a failure                                                                                     |
| `RELAY_REGISTRY_TTL_S`       | `300`               | How long registry entries and CNAME answers are served from cache                                                                |
| `RELAY_REGISTRY_MAX_STALE_S` | `86400`             | How long the last good entry or CNAME answers while the source fails; at most 86400, ≥ TTL                                       |
| `RELAY_DNS_SERVERS`          | system resolvers    | Comma-separated IP addresses for the CNAME check                                                                                 |
| `RELAY_DNS_TIMEOUT_MS`       | `3000`              | A slower DNS answer counts as an error                                                                                           |
| `LOG_LEVEL`                  | `info`              | `info`, `warn` or `error`                                                                                                        |

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

## Registry and DNS caching

Every registry adapter is wrapped by `createCachedRegistry`: entries are fresh for `RELAY_REGISTRY_TTL_S`; when a refresh fails, times out or throws, the last entry answers while it is younger than `RELAY_REGISTRY_MAX_STALE_S` (logged as `registry.stale`), and after that the engine is `unavailable`, so a suspension takes effect within 24 hours even during a dashboard outage. `not-found` is cached for 30 seconds. Concurrent lookups for one engine share one request. CNAME answers follow the same rules (`dns.stale`), except that a definite answer (no record, another target) replaces a cached one at once.
