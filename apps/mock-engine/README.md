# @ptbk/mock-engine

A stand-in for the real engine that speaks every real contract: it registers with the dashboard, dials the relays, serves TLS inside the tunnel, serves the engine API with seeded fake data, sends signed heartbeats and, in a later task, runs the UI loader ([ADR 0004](../../docs/adr/0004-mock-engine-and-conformance.md)). No shortcuts the real engine would not have: everything goes through `@ptbk/protocol`, which makes this the reference implementation for the engine team.

## What runs today (M-01)

- A persistent Ed25519 identity in `PTBK_DATA_DIR/engine-key.pem` (PKCS#8, mode 0600, directory 0700). Startup refuses a key or directory that group or others can access, like OpenSSH. The key is generated extractable only to write it once; at runtime it is a non-extractable WebCrypto key.
- One tunnel per relay in `PTBK_RELAYS`, each independent: `idle → connecting → handshaking → ready → backoff`. The handshake is C-02's: the engine refuses to sign a challenge for a relay other than the one it dialled, signs both sides' version and feature lists, and closes with `PROTOCOL_ERROR` if `ready` is not exactly the negotiation of the signed lists.
- Reconnect with full-jitter backoff (500 ms base, factor 2, 10 s cap, reset after 60 s ready). `SHUTTING_DOWN` on a ready tunnel retries within 500 ms; `REPLACED` stops that relay's link for good (another holder of the key took the slot, and reconnecting would replace it in turn); everything else backs off.
- `HTTPS_PROXY` with `CONNECT` (basic auth from the URL) and `NO_PROXY`; the relay certificate is verified for the relay hostname through the proxy too.
- Each stream the relay opens becomes a Node `Duplex` (`TunnelDuplex`) with `WINDOW` flow control: credit flows back only as the consumer reads.

## TLS and HTTP inside the tunnel (M-02)

Browser TLS ends in the engine, never on the relay: each tunnel stream goes to a TLS server (TLS 1.3 only, ALPN `http/1.1`) that picks the certificate per SNI from a `CertificateSource`, so a renewal applies to the next connection. An unknown or missing SNI fails the handshake; there is no default certificate. Behind it, a Hono app on a `node:http` server that never listens serves the decrypted connections, and WebSocket upgrades go to `ws`. The engine holds certificates for `<engineId>.<PTBK_ENGINE_DOMAIN>` plus every hostname a relay confirmed in `ready`.

Each stream gets its own small `tls.Server` (they share the SNI contexts): a `TLSSocket` over a JS stream has no peer address and no public link back to its stream, so one shared server could not tell the HTTP layer which `OPEN` frame, and so which client IP, a request came from. HTTP/2 is not offered yet; HTTP/1.1 covers SSE, WebSockets and downloads.

Every route is declared through `defineHttpRoute` or `defineWebSocketRoute` (`src/adapters/http/route.ts`) with an auth mode (`public`, `session` or `control`), a permission where the policy needs one, a per-client-IP rate limit and strict zod schemas for path parameters, query, headers and a size-capped body; unknown or repeated query parameters and values over a cap are a 400 problem+json, an oversized body 413. The route-table test checks the public allowlist, the self-scoped session routes without a permission, the engine API against `ENGINE_API_ROUTE_LIST`, and that no `control` route can be mounted in the tunnel. Every response carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `ENGINE_UI_CSP` from `@ptbk/engine-api` (M-05 adds the full header set).

| Route                                   | What it does                                                                                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /`, `GET /__spike/`                | Static page naming the engine ID; no inline script or style. `/` serves it until M-05 mounts the UI                                                                                                            |
| `GET /__spike/whoami`                   | `{ engineId, hostname, clientIp, alpn, tlsVersion }`; `clientIp` is the address from the tunnel's `OPEN` frame                                                                                                 |
| `GET /__spike/sse?count=N&intervalMs=M` | `N` (1–1000, default 20) events every `M` ms (0–10000, default 1000), IDs `1..N`; resumes after `Last-Event-ID`, 204 when done                                                                                 |
| `WS /__spike/ws`                        | Echo, text and binary, up to 1 MiB per message (larger closes with 1009)                                                                                                                                       |
| `WS /__spike/screencast?fps=F&bytes=B`  | Binary frames of `B` bytes (12 B–1 MiB, default 64 KiB) at `F` fps (1–30, default 5): u32 sequence, float64 send time in ms, both big-endian; drops a frame rather than queue it behind two others (or 64 KiB) |
| `GET /__spike/download?bytes=N`         | `N` bytes (up to 1 GiB) with `Content-Length`, produced only as the connection drains                                                                                                                          |

Rate limits per client IP: 600 requests a minute, 60 for download and screencast.

## Engine API (M-04)

The engine API is not reimplemented here. `@ptbk/engine-api/in-memory`'s core holds all state and every handler (validation, permissions, audit chain, events, streamed replies), and `@ptbk/engine-api/http` serves it; the mock adds only what a separate process needs. `src/adapters/http/api-routes.ts` declares one route per entry of `ENGINE_API_ROUTE_LIST`, with the table's method, path, permission and schemas, and hands each request to the core with the request's actor. The route helper caps the body and checks the declared headers; params, query and body are parsed by the binding with the same strict schemas, after the capability and permission checks, so a caller without the permission gets 403 whatever its input (C-04's order). Capabilities are off (`capabilities: []`) until M-07; `GET /engine` reports the engine ID, hostname and `mode: tunnel`, and `dashboardUrl` stays `null` until M-06 sets it. `GET /security` lists each relay as `connected`, `connecting` or `disconnected` from the tunnel links, plus the hostnames relays confirmed. The relays' ping round trip, the hostnames' certificate status and claim, the release log entry UUIDs and the CT check are not wired yet and read as `null` or the core's placeholders.

**Data.** `MOCK_SEED`, `MOCK_SCENARIO` and `MOCK_SEED_EPOCH` fully determine the state: faker (only at seed time) and a seeded sequence for IDs, never the crypto `Random`. Scenarios: `empty` (owner only), `small-team` (owner, admin, two members, a viewer; about 8 agents with chat history, including untitled chats from public visitors on public and unlisted agents, secrets metadata, an `Injection demo` agent whose replies carry hostile markdown for engine-ui's sanitiser), `large-fleet` (about 500 agents, 40 members, long chats for paging). Replies are generated per seed, chat and turn, as markdown with code blocks, tables and links, paced at about 30 tokens a second; they keep generating without a reader, and only the cancel route stops them.

**Gateway stand-in** (`src/domain/gateway/sessions.ts`, `src/adapters/http/gateway-middleware.ts`), not a port of the engine's gateway:

- Cookie `__Host-ptbk_session`: `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`. Its value is a 128-bit token from the crypto `Random`, separate from the session ID that `GET /sessions` lists, and new on every sign-in.
- Sessions end after 30 minutes idle or 12 hours, or as soon as the core no longer lists them: revoking a session or removing a member through the API signs it out. The member's role is read on every request.
- A sign-in stands in for an assertion with the member's newest passkey, which becomes the session's `passkeyId`, so revoking that passkey signs the session out.
- A sign-in counts as a fresh passkey assertion for 5 minutes; after that, `stepUp` routes answer 401 `step-up-required` until the step-up form is used.
- State-changing requests need `Origin` equal to `https://<Host>` (with `Host` naming the SNI hostname) and `Sec-Fetch-Site` `same-origin` or `none`, else 403 before anything else runs. Browsers send both; non-browser clients such as the conformance suite must send them too.
- Anonymous API requests get 401 problem+json; anonymous documents are redirected to `/auth/sign-in`. `POST /auth/sign-out` ends the session.
- `MOCK_DEV_LOGIN=enabled` turns `/auth/sign-in` into a page listing the members (a form per member) and adds a dev step-up form at `/auth/step-up`. There is no WebAuthn in the mock.

**Policy** (`src/domain/authorization/policy.ts`, the mock's guess at engine policy until the engine team confirms it): `owner` holds every permission; `admin` all but `settings.manage`; `member` reads and writes agents, chats and files, reads secret metadata, members, runs, triggers and integrations, controls runs and manages triggers; `viewer` only reads agents, chats, files, members, runs, triggers and integrations. A session from `/__mock/sessions` with a permission set holds exactly that set. The one rule on top: without `members.manage`, a member changes (`agents.write`, `agents.delete`, `agents.run`) only agents they created; a refusal is the core's usual 403 and an audited `denied`.

**Faults** (`MOCK_FAULTS` or `PUT /__mock/faults`, a strict `FaultPlan`): `latencyMs { min, max }`, `errorRate` with `errorStatus` (500, 502 or 503, sent as `internal-error`, `reply-failed` or `unavailable`, the contract's problem for each status), `dropStreamRate` (an SSE response is cut after a random 1 to 20 events), `slowTunnelBytesPerS` (every tunnel stream is throttled towards the browser) and `routes` (path globs, `*` within a segment, `**` across). Decisions draw from a sequence seeded by `MOCK_SEED`, and a new plan applies from the next request.

**Control listener** (`MOCK_CONTROL=enabled`): plain HTTP on `MOCK_CONTROL_HOST:MOCK_CONTROL_PORT` (default `127.0.0.1:4480`), never mounted in the tunnel; through the tunnel `/__mock/*` is 404 (a `GET` from an anonymous visitor is sent to sign-in first, like any page). Bodies are strict.

| Route                   | What it does                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /__mock/state`     | Seed, scenario and counts                                                                                                                                                                               |
| `POST /__mock/reset`    | `{ scenario, seed }`: a new core; the dashboard URL, relay status and last heartbeat are applied again, and every session ends                                                                          |
| `PUT /__mock/faults`    | A `FaultPlan`                                                                                                                                                                                           |
| `DELETE /__mock/faults` | No faults                                                                                                                                                                                               |
| `GET /__mock/heartbeat` | `{ lastHeartbeat: { sentAt, body } \| null, clockSkew: { seconds, measuredAt } \| null }`                                                                                                               |
| `GET /__mock/members`   | IDs, names, roles and statuses                                                                                                                                                                          |
| `POST /__mock/sessions` | `{ subject: { kind: 'owner' } \| { kind: 'member', role } \| { kind: 'member', permissions } }` → `{ memberId, cookie: { name, value } }`; each permission set gets a new synthetic member              |
| `GET /__mock/ui`        | The UI loader's policy, active and previous bundle (`version`, `sha256`, `logIndex`) and last outcome; 404 without the loader                                                                           |
| `POST /__mock/ui/check` | `{ pinnedVersion? }`: one update check now, after re-pinning under `pinned` (the owner's settings change; 400 otherwise); under `manual` this is the owner's approval. Answers `{ outcome, ...status }` |

Startup fails with `NODE_ENV=production` when `MOCK_CONTROL`, `MOCK_DEV_LOGIN` or `MOCK_UI_FAKE_PROVENANCE` is enabled.

## Registration and heartbeat (M-06)

The engine's only conversation with the dashboard, straight over HTTPS (never through a relay), through `HTTPS_PROXY` and `NO_PROXY` like the tunnels and trusting `MOCK_EXTRA_CA_FILE` as well as the default roots.

**Startup.** With `PTBK_DASHBOARD_URL` set: a stored `registration.json` is loaded and checked again against the key, the engine domain and the dashboard (a mismatch stops startup); otherwise `PTBK_LINK_CODE` registers; with neither, startup fails. Without `PTBK_DASHBOARD_URL` the engine runs in the M1 dev mode on `PTBK_RELAYS`, without registration or heartbeats. The registration's relays replace `PTBK_RELAYS` unless `MOCK_RELAYS_OVERRIDE=enabled`, and `GET /engine` reports the dashboard URL.

**Registration** (`src/domain/registration/register.ts`): the request is built and signed with `signRegistration` (`mode: tunnel`), the answer is read tolerantly (`TolerantRegisterEngineResponse`, unknown fields stripped, known ones checked, within `REGISTER_RESPONSE_MAX_BYTES`) and then checked with `checkRegistrationResponse`: an engine ID the key does not derive, or a hostname outside the engine domain, is refused and nothing is stored. Problem codes map to `rejected` with the C-03 reason (`invalid-link-code` covers unknown, expired and used codes alike); no answer, a timeout or an error without a readable problem is `unavailable`. An engine that already holds a registration makes no network call. Re-registering a kept key after `registration.json` is lost is idempotent on the dashboard and yields the same engine ID. The link code is taken once from the configuration (and removed from `process.env`), never stored or logged.

**Heartbeat** (`src/domain/heartbeat/`): the first beat as the tunnels start, then one every `MOCK_HEARTBEAT_INTERVAL_S` (default 60). Each beat takes the next `seq` (`max(last + 1, now in ms)`, persisted in `PTBK_DATA_DIR/heartbeat-seq` with a temporary file, `fsync`, rename and a directory `fsync` before the body is built), builds the body with `buildHeartbeat`, signs those exact bytes with `signHeartbeat` and posts them. A failed send is logged with its status code only, not retried, and not backfilled; a beat still in flight when the next is due makes that one skip. The body is kept verbatim as the security panel's `lastHeartbeat` (also across `/__mock/reset`), from the moment it is sent. A `stale-timestamp` answer with `serverTime` records the clock skew (local clock minus `serverTime`, with when it was measured) and logs `heartbeat.clock-skew` with the seconds only; without `serverTime` the skew is unknown, and an accepted beat clears it. The security panel reports the body with the exact `Ptbk-Signature` value sent (`lastHeartbeat`) and the skew (`clockSkew`), and `GET /__mock/heartbeat` shows both too.

Figures: disk use of the data directory's file system and memory use (rounded to tens by `buildHeartbeat`), the 1-minute load per core as `low` (< 0.5), `medium` (< 1) or `high`, agents and active members from the engine API's state, and `update: none` until the UI loader (M-05) reports one. With `MOCK_STATS=scenario` disk, memory and CPU are fixed per scenario (`empty` 10/20/low, `small-team` 40/50/medium, `large-fleet` 70/80/high), so e2e can assert exact dashboard values.

## UI loader (M-05)

The mock engine is the reference UI loader for the engine team ([ui-loader.md](../../docs/engine-integration/ui-loader.md)). With `PTBK_UI_RELEASE_URL` set it checks the release store at startup, every `MOCK_UI_CHECK_INTERVAL_S` and on `POST /__mock/ui/check`, one check at a time ([ui-update.ts](src/domain/ui/ui-update.ts)): C-06's `verifyRelease` decides on the signed release with the trust policy from `MOCK_UI_TRUST_POLICY_FILE`, the persisted `firstSeenAt` and `lastAcceptedRevocationIssuedAt` (`PTBK_DATA_DIR/ui/update-state.json`) and the Sigstore verifier from `@ptbk/release-tools` against the pinned trusted root; then the `ui` artifact's SHA-256, the unpacked files against the manifest and the manifest's `engineApi` range against `ENGINE_API_VERSION`. A bundle that passes is unpacked into `PTBK_DATA_DIR/ui/<version>-<sha256 prefix>/` (read-only) and becomes active atomically; anything else is logged as `ui.refused` (reason and version only) and the previous bundle keeps being served. Every check's outcome, with the refusal and revocation reasons, is the security panel's `ui.lastUpdateCheck`.

`/` and every other path no route takes serve the active bundle behind the gateway session: only files its verified manifest lists, content-hashed assets cached as immutable, `index.html` as the fallback for documents outside those paths and `/assets/`. The engine's own paths (`/api/`, `/auth/`, `/setup`, `/.well-known/`, `/__spike/`, `/__mock/`) are never served from a bundle, and a manifest listing a file there is refused at install. Before the first install the answer is a plain 503 page. Every in-tunnel response carries the engine's headers ([security-headers.ts](src/domain/http/security-headers.ts)): `ENGINE_UI_CSP`, HSTS, COOP and CORP `same-origin`, `Referrer-Policy: no-referrer`, `nosniff`, `X-Frame-Options: DENY` and a `Permissions-Policy` that disables camera, microphone, geolocation, payment and USB. They are engine code; the bundle's manifest `csp` is never read. The security panel's `ui` shows the active bundle's version, archive SHA-256 and Rekor log index.

No revocation list is published yet, and `verifyRelease` refuses every release without a fresh one, so against the real release store the loader installs nothing until one exists ([open points](../../docs/engine-integration/README.md#open-points)). Tests and the e2e stack sign their own lists at run time.

## ACME TLS-ALPN-01 (M-03)

With `MOCK_CERT_SOURCE=acme` the engine obtains its certificate from an ACME CA (`PTBK_ACME_DIRECTORY_URL`) with TLS-ALPN-01 (RFC 8737), validated through the relay it is reachable by: no DNS record is ever touched. The relay routes the CA's validation connection by SNI exactly like a browser (it never looks at ALPN), so telling the two apart is the engine's job:

- A ClientHello router (`client-hello-router.ts`) sits in front of every TLS server inside the tunnel. It reads each stream's ClientHello with `@ptbk/protocol`'s parser (SNI and ALPN; never a local one), puts the bytes back (`unshift`) and decides (`domain/tls/alpn-dispatch.ts`): a hello offering exactly `acme-tls/1` for a hostname with a challenge pending goes to the responder; any other `acme-tls/1` hello (no challenge pending, mixed with other protocols, no SNI) is closed before a byte is written, as is anything that is not a ClientHello or does not complete within 10 s. Everything else goes to the normal TLS server. In `dev-ca` mode no challenge is ever pending, so every `acme-tls/1` hello is refused.
- The responder (`tls-alpn-responder.ts`) is a TLS 1.3 server offering only `acme-tls/1` that presents the challenge certificate (`acme-client`'s `createAlpnCertificate`, with the critical `acmeIdentifier` extension) and closes after the handshake. Challenge certificates live only in memory (`domain/tls/acme-challenges.ts`), registered just before the CA is asked to validate and removed as soon as the authorization settles, valid or not.
- The source (`acme-certificate-source.ts`) holds one certificate for every engine hostname, in `PTBK_DATA_DIR/tls/` (`certificate.pem`, `key.pem`, 0600; directory 0700), so a restart serves the same one. It starts ordering only once a relay reports the tunnel ready (the CA validates through it), renews once a third of the lifetime remains (`domain/tls/renewal-policy.ts`; looked at every 12 h and when due), retries failures after 5 s doubling to an hour while the current certificate keeps being served, and gives up on an issuance after 120 s. A renewal reaches new connections through `onChange`; open ones carry on with the old certificate.
- The issuer (`acme-client-issuer.ts`, `acme-client` 5.4.0) runs one order: account (created once per process), order for every hostname, the `tls-alpn-01` challenge per authorization, then a CSR from a fresh local ECDSA P-256 key (SANs only, no common name: an engine hostname can exceed its 64 characters) and the chain. It sits behind the `CertificateIssuer` port, so the production client, the engine team's choice (ADR 0014: `acme-client` is unmaintained and only for this Pebble spike), replaces this one file.
- The ACME account key is `PTBK_DATA_DIR/acme/account-key.pem` (ECDSA P-256, 0600, created once). It is not the engine key: the engine's Ed25519 identity signs only our own protocol, and the account is a separate identity at the CA.
- The ACME server's own TLS trust comes from the process (`NODE_EXTRA_CA_CERTS`), never from changing `acme-client`'s global axios instance. `acme-client`'s axios also honours `HTTPS_PROXY`.
- Logged: `acme.order-created` (identifier count), `acme.challenge-served` and `acme.challenge-valid` (hostname), `acme.certificate-issued` and `acme.certificate-loaded` (`notAfter`), `acme.issue-failed` (error name, stage, failures, retry delay, whether a certificate is still served), `tls.hello-rejected` (reason). Never a key, a key authorization, a token, an account URL or a CA response text.

The e2e `acme` scenario runs it against Pebble through the relays; the result and the Let's Encrypt staging runbook are in [docs/spike/acme-tls-alpn-01.md](../../docs/spike/acme-tls-alpn-01.md).

## Dev CA

For development and e2e the engine's certificates come by default from a local dev CA (`MOCK_CERT_SOURCE=dev-ca`). It must never be trusted outside development, so it is built to be harmless if it leaks:

- ECDSA P-256, valid one year, `basicConstraints` CA with `pathLen 0`, key usage `keyCertSign` and `cRLSign` only.
- A **critical name constraints** extension: it permits only `PTBK_ENGINE_DOMAIN` and the domains in `MOCK_DEV_CA_DOMAINS` (and their subdomains), and excludes every IP address (`0.0.0.0/0` and `::/0`). A browser that trusts it still refuses it for any other site.
- Leaves last 7 days (SANs for every engine hostname, `digitalSignature`, EKU `serverAuth`) and are re-issued when a third of their lifetime remains.
- No key is committed, printed or logged. With `MOCK_DEV_CA_CERT_FILE` and `MOCK_DEV_CA_KEY_FILE` set (X-01 generates them so Playwright and curl can trust the CA before the engine starts), the engine uses those and refuses a CA without the constraints above or a key file readable by group or others. Otherwise it generates the CA into `PTBK_DATA_DIR/dev-ca/` (`ca-cert.pem` and `ca-key.pem`, mode 0600, directory 0700) and reuses it, generating a new one when the permitted domains change or it is within 7 days of expiry.

To trust it locally, add `PTBK_DATA_DIR/dev-ca/ca-cert.pem` to the browser's or the system's trust store, or pass it to curl with `--cacert`. Remove it again when you are done.

## Configuration

| Variable                      | Meaning                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `PTBK_MODE`                   | `tunnel` (default; the only mode the mock supports)                                                     |
| `PTBK_DATA_DIR`               | Required. Holds `engine-key.pem`, `registration.json`, `heartbeat-seq`, `ui/`, and `acme/` and `tls/`   |
| `PTBK_RELAYS`                 | Comma-separated `wss://<relay hostname>[:port][/v1/tunnel]` URLs. Required without `PTBK_DASHBOARD_URL` |
| `PTBK_DASHBOARD_URL`          | The dashboard's `https://` origin; enables registration and heartbeats                                  |
| `PTBK_LINK_CODE`              | One-time link code for the first registration; needs `PTBK_DASHBOARD_URL`                               |
| `MOCK_HEARTBEAT_INTERVAL_S`   | Seconds between heartbeats, 1 to 3600, default 60 (e2e uses 15)                                         |
| `MOCK_RELAYS_OVERRIDE`        | `enabled` keeps `PTBK_RELAYS` instead of the registration's relays; default `disabled`                  |
| `MOCK_STATS`                  | `os` (default) or `scenario`: where disk, memory and CPU figures come from                              |
| `PTBK_ENGINE_DOMAIN`          | Required. The engine's default hostname is `<engineId>.<PTBK_ENGINE_DOMAIN>`                            |
| `PTBK_ENGINE_VERSION`         | Signed into the tunnel `auth`; defaults to this package's version                                       |
| `HTTPS_PROXY` / `https_proxy` | `http://[user:password@]host:port`; both set and different is an error                                  |
| `NO_PROXY` / `no_proxy`       | Comma-separated hosts (and their subdomains), optional `:port`, or `*`                                  |
| `MOCK_EXTRA_CA_FILE`          | PEM added to Node's default roots, for the dev relay CA or a TLS-inspecting proxy                       |
| `MOCK_DEV_CA_CERT_FILE`       | PEM dev CA certificate to issue engine certificates from; set together with `MOCK_DEV_CA_KEY_FILE`      |
| `MOCK_DEV_CA_KEY_FILE`        | Its PKCS#8 PEM ECDSA P-256 key, mode 0600 or stricter                                                   |
| `MOCK_DEV_CA_DOMAINS`         | Comma-separated e2e domains a generated dev CA permits besides `PTBK_ENGINE_DOMAIN`                     |
| `MOCK_CERT_SOURCE`            | `dev-ca` (default) or `acme`; each refuses the other's settings                                         |
| `PTBK_ACME_DIRECTORY_URL`     | Required with `acme`: the CA's `https://` directory URL                                                 |
| `PTBK_ACME_EMAIL`             | Optional account contact with `acme`                                                                    |
| `LOG_LEVEL`                   | `info` (default), `warn`, `error`                                                                       |
| `MOCK_SEED`                   | Integer 0 to 2³²−1, default 1                                                                           |
| `MOCK_SCENARIO`               | `empty`, `small-team` (default) or `large-fleet`                                                        |
| `MOCK_SEED_EPOCH`             | RFC 3339 UTC; seeded timestamps lie before it. Default `2026-10-01T00:00:00Z`                           |
| `MOCK_FAULTS`                 | A JSON `FaultPlan`; default none                                                                        |
| `MOCK_DEV_LOGIN`              | `enabled` or `disabled` (default)                                                                       |
| `MOCK_CONTROL`                | `enabled` or `disabled` (default)                                                                       |
| `MOCK_CONTROL_HOST`           | IP or hostname for the control listener, default `127.0.0.1`                                            |
| `MOCK_CONTROL_PORT`           | Default `4480`                                                                                          |
| `PTBK_UI_RELEASE_URL`         | `https://` URL of the release store or mirror, path ending in `/`; enables the UI loader                |
| `PTBK_UPDATE_POLICY`          | `auto` (default), `manual` or `pinned`                                                                  |
| `PTBK_PINNED_VERSION`         | The version to install; required with `pinned`, refused otherwise                                       |
| `MOCK_UI_TRUST_POLICY_FILE`   | Required with `PTBK_UI_RELEASE_URL`: C-06's `TrustPolicy` as JSON                                       |
| `MOCK_UI_TRUSTED_ROOT_FILE`   | A Sigstore `trusted_root.json` instead of the pinned one in `@ptbk/release-tools`                       |
| `MOCK_UI_CHECK_INTERVAL_S`    | Seconds between update checks, 1 to 86400, default 3600                                                 |
| `MOCK_UI_FAKE_PROVENANCE`     | `enabled` accepts test attestations instead of Sigstore (tests and e2e only; refused in production)     |

Logs are JSON lines with relay URLs, states, close codes, attempt numbers, certificate expiry and dashboard status codes; never a key, signatures, the link code, heartbeat bodies, proxy credentials or stream bytes.

## Commands

- `bun run --filter @ptbk/mock-engine dev`: run from source with `tsx watch`.
- `bun run --filter @ptbk/mock-engine build` then `start`: one bundled file, `dist/main.mjs`, for Node 24.
- `bun run --filter @ptbk/mock-engine register --link <code>` (or `node dist/main.mjs register --link <code>`): registers with `PTBK_DASHBOARD_URL` (or finds the stored registration) and exits, printing `{ outcome, engineId, hostname, relays }` or `{ outcome, reason }` as JSON; exit code 0 only when registered (X-05).
- `bun run --filter @ptbk/mock-engine identity`: prints `{ engineId, enginePublicKey, hostname }` as JSON, creating the identity if missing (X-01 writes the relay's static registry from it). Needs `PTBK_DATA_DIR` and `PTBK_ENGINE_DOMAIN`.
- `bun run --filter @ptbk/mock-engine dev-ca`: creates the dev CA in `PTBK_DATA_DIR/dev-ca/` exactly as startup would (or reuses it) and prints its file paths and permitted domains as JSON, so tools can trust it before the engine runs (X-01). Reads `PTBK_DATA_DIR`, `PTBK_ENGINE_DOMAIN` and `MOCK_DEV_CA_DOMAINS`.
- `bun run --filter @ptbk/mock-engine dev-ca issue <cert-file> <key-file> <hostname>...`: also issues a 7-day leaf from that CA for another dev service, such as X-01's relays (key 0600). Only names under `MOCK_DEV_CA_DOMAINS` are accepted; engine hostnames are refused, so their certificates come from the engine alone.

## Layout

- `src/domain/`: the tunnel state machine (`tunnel/relay-link.ts`), the per-tunnel stream state (`tunnel/stream-mux.ts`), backoff, the rate limiter, the seed, scenarios and engine runtime (`state/`), the role policy (`authorization/`), gateway sessions (`gateway/`), the reply generator (`chat/`), fault plans (`faults/`), registration (`registration/`), the heartbeat (`heartbeat/`), the ClientHello dispatch, renewal policy and pending challenges (`tls/`), and the ports (`RelayDialer`, `IdentityStore`, `CertificateSource`, `CertificateIssuer`, `DashboardApi`, `RegistrationStore`, `SeqStore`, `SystemStats`, `EngineStatsSource`, `Clock`, `Logger`, `Random`). No Node APIs; tested with fakes only.
- `src/adapters/`: `ws` dialer with TLS verification and pings, the `CONNECT` proxy client, the `Duplex` per stream, the file identity store, the dev CA (`dev-ca.ts` on a small DER writer in `x509/`), the ClientHello router, the TLS server (`tls-stream-server.ts`), the ACME side (`acme-*.ts`, `tls-alpn-responder.ts`), the tunnel throttle, the HTTP app with the spike, gateway and engine API routes and the fault middleware (`http/`), the control listener (`control-server.ts`), and the dashboard side: the HTTPS `fetch` (`https-fetch.ts`), the dashboard client (`fetch-dashboard-api.ts`), the registration and `seq` files and the host's figures.
- `src/app/`: config parsing and the composition root, `startMockEngine(config, deps)`: tunnel streams → ClientHello router → TLS server → HTTP app (or the TLS-ALPN-01 responder) when given `certificates`; `onStream(handler)` replaces that handler in tests.
- `src/testing/`: fakes, a test PKI, a fake ACME issuer and a minimal in-process ACME server for `acme-client` (`test/acme-issuance.test.ts` runs the real client through the router and responder), an in-test relay with an SNI passthrough, a `CONNECT` proxy, an in-process engine harness (TLS server and HTTP app over linked duplexes), the engine API harness with a `fetch` over those connections, and a recorder that checks every engine API response against its strict schema. `test/`: integration tests across real sockets, including engine-api's shared client suite run through the in-test relay.

The DER writer is hand-rolled: the catalog's `@peculiar/asn1-*` packages resolve to two copies whose schema registries do not see each other, and `@peculiar/x509` needs a global `reflect-metadata` polyfill. Signing is `node:crypto` (OpenSSL), and the tests verify every certificate through `node:tls`.

Still to come: the UI loader and full security headers (M-05), capabilities and the live simulation (M-07).
