# @ptbk/mock-engine

A stand-in for the real engine that speaks every real contract: it dials the relays, serves TLS inside the tunnel and, in later tasks, registers with the dashboard, sends signed heartbeats, runs the UI loader and serves the engine API with seeded fake data ([ADR 0004](../../docs/adr/0004-mock-engine-and-conformance.md)). No shortcuts the real engine would not have: everything goes through `@ptbk/protocol`, which makes this the reference implementation for the engine team.

## What runs today (M-01)

- A persistent Ed25519 identity in `PTBK_DATA_DIR/engine-key.pem` (PKCS#8, mode 0600, directory 0700). Startup refuses a key or directory that group or others can access, like OpenSSH. The key is generated extractable only to write it once; at runtime it is a non-extractable WebCrypto key.
- One tunnel per relay in `PTBK_RELAYS`, each independent: `idle → connecting → handshaking → ready → backoff`. The handshake is C-02's: the engine refuses to sign a challenge for a relay other than the one it dialled, signs both sides' version and feature lists, and closes with `PROTOCOL_ERROR` if `ready` is not exactly the negotiation of the signed lists.
- Reconnect with full-jitter backoff (500 ms base, factor 2, 10 s cap, reset after 60 s ready). `SHUTTING_DOWN` on a ready tunnel retries within 500 ms; `REPLACED` stops that relay's link for good (another holder of the key took the slot, and reconnecting would replace it in turn); everything else backs off.
- `HTTPS_PROXY` with `CONNECT` (basic auth from the URL) and `NO_PROXY`; the relay certificate is verified for the relay hostname through the proxy too.
- Each stream the relay opens becomes a Node `Duplex` (`TunnelDuplex`) with `WINDOW` flow control: credit flows back only as the consumer reads.

## TLS and HTTP inside the tunnel (M-02)

Browser TLS ends in the engine, never on the relay: each tunnel stream goes to a TLS server (TLS 1.3 only, ALPN `http/1.1`) that picks the certificate per SNI from a `CertificateSource`, so a renewal applies to the next connection. An unknown or missing SNI fails the handshake; there is no default certificate. Behind it, a Hono app on a `node:http` server that never listens serves the decrypted connections, and WebSocket upgrades go to `ws`. The engine holds certificates for `<engineId>.<PTBK_ENGINE_DOMAIN>` plus every hostname a relay confirmed in `ready`.

Each stream gets its own small `tls.Server` (they share the SNI contexts): a `TLSSocket` over a JS stream has no peer address and no public link back to its stream, so one shared server could not tell the HTTP layer which `OPEN` frame, and so which client IP, a request came from. HTTP/2 is not offered yet; HTTP/1.1 covers SSE, WebSockets and downloads.

Every route is declared through `defineHttpRoute` or `defineWebSocketRoute` (`src/adapters/http/route.ts`) with an auth mode, a per-client-IP rate limit and strict zod schemas; unknown or repeated query parameters and values over a cap are a 400 problem+json. Every response carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `ENGINE_UI_CSP` from `@ptbk/engine-api` (M-05 adds the full header set).

| Route                                   | What it does                                                                                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`, `GET /__spike/`                | Static page naming the engine ID; no inline script or style. `/` serves it until M-05 mounts the UI                                                                                                            |
| `GET /__spike/whoami`                   | `{ engineId, hostname, clientIp, alpn, tlsVersion }`; `clientIp` is the address from the tunnel's `OPEN` frame                                                                                                 |
| `GET /__spike/sse?count=N&intervalMs=M` | `N` (1–1000, default 20) events every `M` ms (0–10000, default 1000), IDs `1..N`; resumes after `Last-Event-ID`, 204 when done                                                                                 |
| `WS /__spike/ws`                        | Echo, text and binary, up to 1 MiB per message (larger closes with 1009)                                                                                                                                       |
| `WS /__spike/screencast?fps=F&bytes=B`  | Binary frames of `B` bytes (12 B–1 MiB, default 64 KiB) at `F` fps (1–30, default 5): u32 sequence, float64 send time in ms, both big-endian; drops a frame rather than queue it behind two others (or 64 KiB) |
| `GET /__spike/download?bytes=N`         | `N` bytes (up to 1 GiB) with `Content-Length`, produced only as the connection drains                                                                                                                          |

Rate limits per client IP: 600 requests a minute, 60 for download and screencast.

## Dev CA

For development and e2e the engine's certificates come from a local dev CA (M-03 adds ACME). It must never be trusted outside development, so it is built to be harmless if it leaks:

- ECDSA P-256, valid one year, `basicConstraints` CA with `pathLen 0`, key usage `keyCertSign` and `cRLSign` only.
- A **critical name constraints** extension: it permits only `PTBK_ENGINE_DOMAIN` and the domains in `MOCK_DEV_CA_DOMAINS` (and their subdomains), and excludes every IP address (`0.0.0.0/0` and `::/0`). A browser that trusts it still refuses it for any other site.
- Leaves last 7 days (SANs for every engine hostname, `digitalSignature`, EKU `serverAuth`) and are re-issued when a third of their lifetime remains.
- No key is committed, printed or logged. With `MOCK_DEV_CA_CERT_FILE` and `MOCK_DEV_CA_KEY_FILE` set (X-01 generates them so Playwright and curl can trust the CA before the engine starts), the engine uses those and refuses a CA without the constraints above or a key file readable by group or others. Otherwise it generates the CA into `PTBK_DATA_DIR/dev-ca/` (`ca-cert.pem` and `ca-key.pem`, mode 0600, directory 0700) and reuses it, generating a new one when the permitted domains change or it is within 7 days of expiry.

To trust it locally, add `PTBK_DATA_DIR/dev-ca/ca-cert.pem` to the browser's or the system's trust store, or pass it to curl with `--cacert`. Remove it again when you are done.

## Configuration

| Variable                      | Meaning                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| `PTBK_MODE`                   | `tunnel` (default; the only mode the mock supports)                                                       |
| `PTBK_DATA_DIR`               | Required. Holds `engine-key.pem`                                                                          |
| `PTBK_RELAYS`                 | Required. Comma-separated `wss://<relay hostname>[:port][/v1/tunnel]` URLs (M-06 makes it a dev override) |
| `PTBK_ENGINE_DOMAIN`          | Required. The engine's default hostname is `<engineId>.<PTBK_ENGINE_DOMAIN>`                              |
| `PTBK_ENGINE_VERSION`         | Signed into the tunnel `auth`; defaults to this package's version                                         |
| `HTTPS_PROXY` / `https_proxy` | `http://[user:password@]host:port`; both set and different is an error                                    |
| `NO_PROXY` / `no_proxy`       | Comma-separated hosts (and their subdomains), optional `:port`, or `*`                                    |
| `MOCK_EXTRA_CA_FILE`          | PEM added to Node's default roots, for the dev relay CA or a TLS-inspecting proxy                         |
| `MOCK_DEV_CA_CERT_FILE`       | PEM dev CA certificate to issue engine certificates from; set together with `MOCK_DEV_CA_KEY_FILE`        |
| `MOCK_DEV_CA_KEY_FILE`        | Its PKCS#8 PEM ECDSA P-256 key, mode 0600 or stricter                                                     |
| `MOCK_DEV_CA_DOMAINS`         | Comma-separated e2e domains a generated dev CA permits besides `PTBK_ENGINE_DOMAIN`                       |
| `LOG_LEVEL`                   | `info` (default), `warn`, `error`                                                                         |

Logs are JSON lines with relay URLs, states, close codes, attempt numbers and certificate expiry; never a key, signatures, proxy credentials or stream bytes.

## Commands

- `bun run --filter @ptbk/mock-engine dev`: run from source with `tsx watch`.
- `bun run --filter @ptbk/mock-engine build` then `start`: one bundled file, `dist/main.mjs`, for Node 24.
- `bun run --filter @ptbk/mock-engine identity`: prints `{ engineId, enginePublicKey, hostname }` as JSON, creating the identity if missing (X-01 writes the relay's static registry from it). Needs `PTBK_DATA_DIR` and `PTBK_ENGINE_DOMAIN`.

## Layout

- `src/domain/`: the tunnel state machine (`tunnel/relay-link.ts`), the per-tunnel stream state (`tunnel/stream-mux.ts`), backoff, the rate limiter, and the ports (`RelayDialer`, `IdentityStore`, `CertificateSource`, `Clock`, `Logger`, `Random`). No Node APIs; tested with fakes only.
- `src/adapters/`: `ws` dialer with TLS verification and pings, the `CONNECT` proxy client, the `Duplex` per stream, the file identity store, the dev CA (`dev-ca.ts` on a small DER writer in `x509/`), the TLS server (`tls-stream-server.ts`) and the HTTP app with the spike routes (`http/`).
- `src/app/`: config parsing and the composition root, `startMockEngine(config, deps)`: tunnel streams → TLS server → HTTP app when given `certificates`; `onStream(handler)` replaces that handler in tests.
- `src/testing/`: fakes, a test PKI, an in-test relay with an SNI passthrough, a `CONNECT` proxy, and an in-process engine harness (TLS server and HTTP app over linked duplexes). `test/`: integration tests across real sockets.

The DER writer is hand-rolled: the catalog's `@peculiar/asn1-*` packages resolve to two copies whose schema registries do not see each other, and `@peculiar/x509` needs a global `reflect-metadata` polyfill. Signing is `node:crypto` (OpenSSL), and the tests verify every certificate through `node:tls`.

Still to come: ACME (M-03), the engine API with seeded data and fault injection (M-04), the UI loader (M-05), registration and heartbeat (M-06).
