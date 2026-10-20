# @ptbk/mock-engine

A stand-in for the real engine that speaks every real contract: it dials the relays and, in later tasks, serves TLS inside the tunnel, registers with the dashboard, sends signed heartbeats, runs the UI loader and serves the engine API with seeded fake data ([ADR 0004](../../docs/adr/0004-mock-engine-and-conformance.md)). No shortcuts the real engine would not have: everything goes through `@ptbk/protocol`, which makes this the reference implementation for the engine team.

## What runs today (M-01)

- A persistent Ed25519 identity in `PTBK_DATA_DIR/engine-key.pem` (PKCS#8, mode 0600, directory 0700). Startup refuses a key or directory that group or others can access, like OpenSSH. The key is generated extractable only to write it once; at runtime it is a non-extractable WebCrypto key.
- One tunnel per relay in `PTBK_RELAYS`, each independent: `idle → connecting → handshaking → ready → backoff`. The handshake is C-02's: the engine refuses to sign a challenge for a relay other than the one it dialled, signs both sides' version and feature lists, and closes with `PROTOCOL_ERROR` if `ready` is not exactly the negotiation of the signed lists.
- Reconnect with full-jitter backoff (500 ms base, factor 2, 10 s cap, reset after 60 s ready). `SHUTTING_DOWN` on a ready tunnel retries within 500 ms; `REPLACED` stops that relay's link for good (another holder of the key took the slot, and reconnecting would replace it in turn); everything else backs off.
- `HTTPS_PROXY` with `CONNECT` (basic auth from the URL) and `NO_PROXY`; the relay certificate is verified for the relay hostname through the proxy too.
- Each stream the relay opens becomes a Node `Duplex` (`TunnelDuplex`) with `WINDOW` flow control: credit flows back only as the consumer reads. Without a stream handler (M-02 adds the TLS server), streams are refused.

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
| `LOG_LEVEL`                   | `info` (default), `warn`, `error`                                                                         |

Logs are JSON lines with relay URLs, states, close codes and attempt numbers; never the key, signatures, proxy credentials or stream bytes.

## Commands

- `bun run --filter @ptbk/mock-engine dev`: run from source with `tsx watch`.
- `bun run --filter @ptbk/mock-engine build` then `start`: one bundled file, `dist/main.mjs`, for Node 24.
- `bun run --filter @ptbk/mock-engine identity`: prints `{ engineId, enginePublicKey, hostname }` as JSON, creating the identity if missing (X-01 writes the relay's static registry from it). Needs `PTBK_DATA_DIR` and `PTBK_ENGINE_DOMAIN`.

## Layout

- `src/domain/`: the tunnel state machine (`tunnel/relay-link.ts`), the per-tunnel stream state (`tunnel/stream-mux.ts`), backoff, and the ports (`RelayDialer`, `IdentityStore`, `Clock`, `Logger`, `Random`). No Node APIs; tested with fakes only.
- `src/adapters/`: `ws` dialer with TLS verification and pings, the `CONNECT` proxy client, the `Duplex` per stream, the file identity store.
- `src/app/`: config parsing and the composition root, `startMockEngine(config, deps)`, which exposes `onStream(handler)` for M-02.
- `src/testing/`: fakes, a test PKI, an in-test relay and `CONNECT` proxy. `test/`: integration tests across real sockets.

Still to come: TLS and HTTP inside the streams (M-02), the engine API with seeded data and fault injection (M-04), the UI loader (M-05), registration and heartbeat (M-06).
