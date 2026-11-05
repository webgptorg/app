# Implementation plan for the engine

An ordered build plan for the engine side of the protocol, written so that a coding agent can execute it phase by phase. Each phase ends with checks that must pass before the next one starts. The topic files in this folder stay normative; this plan only orders the work and points into them. [AGENT_BRIEF.md](AGENT_BRIEF.md) is the prompt that hands this plan to an agent.

How to read a phase:

- **Read:** the sections that define the phase. Read them fully before writing code.
- **Build:** what must exist at the end, with links to the normative text. Contract exports are named, never copied.
- **Prove:** the checks that must pass and the exact commands. Every suite named here exists; the only part still pending is the full end-to-end run (task E-03) in phase 9.
- **Reference:** the mock engine files that do the same thing ([mock-engine.md](mock-engine.md)). Port the logic, never the dev-only parts.
- **Pitfalls:** mistakes we made or expect.

Paths like `packages/protocol` are relative to the platform checkout from phase 0 (`$PLATFORM_DIR` below). Paths like `apps/agents-server` are relative to the engine repository.

## Where things go in the engine

The engine is `apps/agents-server` in `webgptorg/promptbook`: a Next.js app router application on Node, installed with npm, with its domain logic (agent collections, the book parser, chat execution, storage) in the monorepo's `src/`. Nothing in it today does what this plan needs: there is no engine key, no tunnel, no TLS server, no ACME, no passkeys and no release verification. The layout below is a suggestion; it is your repository.

| Piece                                                                                        | Suggested home                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity, registration, heartbeat, tunnel client, TLS and ACME, UI loader                    | A new server-only, framework-agnostic module, for example `src/zero-trust/` (the spec proposes a `packages/engine-tunnel` package). Pure logic behind ports, Node adapters beside it, as in the mock engine's `domain/` and `adapters/` split.                                |
| Gateway, the TLS server inside the tunnel, the engine API v1 HTTP binding, UI bundle serving | A separate Node entry point (for example `apps/agents-server/server.ts`, or its own package) that the engine's start command runs in tunnel mode instead of `next start`. It is the only listener.                                                                            |
| Engine API v1 handlers                                                                       | An `EngineApiTransport` implementation over the engine's domain code, mounted with `createEngineApiHttpHandler` from `@ptbk/engine-api/http`. Not Next.js route handlers.                                                                                                     |
| Sessions, passkeys, members, audit chain, secrets, API tokens                                | New tables in the engine's database, through its own migration rules.                                                                                                                                                                                                         |
| Engine key, registration, heartbeat `seq`, UI update state, ACME account key, certificates   | Files in `PTBK_DATA_DIR`, as the topic files require.                                                                                                                                                                                                                         |
| Next.js app                                                                                  | Not reachable from the tunnel. If the engine still needs it for something other than the UI, it listens on 127.0.0.1 only and the gateway never proxies to it. The engine origin serves the gateway pages, `/api/v1` and our bundle, nothing else ([gateway.md](gateway.md)). |

**Replace, do not reuse.** The engine's existing access code must not sit in front of the engine API or the UI: its login and admin login, its session cookie, its API token checks, its CORS handling, its IP and visibility middleware, its server actions, and any custom JavaScript or stylesheet injection. The gateway replaces all of them. The spec's [Security hardening](../spec/zero-trust-spec.md#security-hardening) explains why; the findings, file by file with what replaces each, are in `docs/security/agents-server-review.md` in the platform checkout, a private page for readers with access. Domain logic (agents, books, chat execution, knowledge, file storage) can be reused behind the transport, once you have checked that it takes no access decision of its own from the old request context.

**Two different `/api/v1`s.** The engine already has a management API under `/api/v1` with its own OpenAPI document. It is not our contract and must not be reachable through the gateway. The contract's `/api/v1` is served only from `ENGINE_API_ROUTE_LIST`.

## Phase 0: setup and contracts

**Read:** [README.md](README.md) (the whole page, especially the open points), [cryptography.md](cryptography.md), [conformance.md](conformance.md), [testing-against-the-platform.md](testing-against-the-platform.md).

**Build:**

1. Clone the platform repository next to the engine and pin it to one commit. Bun is needed only inside this checkout, to install and build our tooling; the engine keeps npm.

   ```sh
   git clone git@github.com:webgptorg/app.git ../ptbk-platform
   git -C ../ptbk-platform checkout <commit>
   (cd ../ptbk-platform && bun install && bun run --filter @ptbk/conformance build)
   export PLATFORM_DIR="$(cd ../ptbk-platform && pwd)"
   ```

2. Depend on the contracts by path from the package that holds the new code. This is the supported way to consume them; publishing them to a registry (task E-02) is the maintainer's call and changes nothing else in this plan. npm only links the directories and does not install their dependencies (their `catalog:` and `workspace:` specifiers are Bun's, which npm does not read); `zod`, `@noble/curves`, `@sigstore/*` and `@ptbk/protocol` then resolve from the platform checkout's `node_modules`, which is why `bun install` must have run there. We checked this with npm 11 and Node 24.

   ```sh
   npm install --save "file:$PLATFORM_DIR/packages/protocol" "file:$PLATFORM_DIR/packages/engine-api"
   npm install --save "file:$PLATFORM_DIR/packages/release-tools"   # phase 8, the Sigstore adapter
   ```

3. The packages ship TypeScript source with extensionless imports, so plain `node` cannot run them. Run the new entry point with a loader or bundler that compiles TypeScript from linked packages: `tsx` in development, and esbuild, tsup or tsdown for the production build (the mock engine uses `tsx` and `tsdown`). Check it with a one-line script that imports `deriveEngineId` from `@ptbk/protocol` and `ENGINE_API_VERSION` from `@ptbk/engine-api` and prints the version (`1.9.0` at the time of writing).
4. Give the engine one start command that the conformance harness can run with `--engine-cmd`. Its launch contract: the engine reads its settings from the environment (the variables in [the harness table](testing-against-the-platform.md#engine-settings-the-harness-uses)), creates `PTBK_DATA_DIR` itself if it does not exist, writes its logs to stdout or stderr, exits with a non-zero status when it refuses to start, and exits within 10 s of SIGTERM ([launch contract](identity-and-registration.md#launch-contract)). For the engine API checks, its conformance build also ships the [`conformance-session` command](identity-and-registration.md#conformance-sessions).
5. Add a lint rule that forbids `eval`, `new Function`, `vm` and string timers in the new code.
6. Add a test that runs every case in [`ed25519-vectors.json`](../../packages/protocol/src/ed25519-vectors.json) through `verifyEd25519` and compares `valid`. It proves the import works and keeps you honest if you ever add another verifier.

**Prove:** the import script prints the version; the vector test passes; the conformance CLI answers `node "$PLATFORM_DIR/packages/conformance/dist/ptbk-conformance.js" --help`.

**Pitfalls:**

- Never copy contract sources, schemas or tarballs into the engine repository: the checkout is the one source, and a copy drifts. Whether and when the engine's work goes public is the maintainer's decision.
- The contracts use zod 4 from the platform checkout. Do not compose their schemas with another zod instance; call the exported schemas and parse functions as they are.
- If the engine's typecheck reports errors inside `@ptbk/*` sources, align the compiler options for the new module (the contracts are checked with `strict`, `exactOptionalPropertyTypes`, `lib: ["ES2024", "DOM"]`). Never edit the contract sources.
- Pinning one platform commit matters: the guide, the contracts, the mock engine and the conformance suite at that commit agree with each other. Move the pin deliberately, and rerun every phase's checks when you do.

## Phase 1: identity and key storage

**Read:** [identity-and-registration.md](identity-and-registration.md#engine-key-handling) (Engine key handling, Engine ID and hostname, Engine fingerprint), [cryptography.md](cryptography.md) (Signing input, Randomness and secrets).

**Build:**

- Load or create the engine key in `PTBK_DATA_DIR` exactly as the seven numbered rules say: 0700 directory, `O_CREAT | O_EXCL` and 0600, `fsync` of file then directory, ownership, mode and symlink checks, non-extractable at runtime. Use `generateEd25519KeyPair`, `importEd25519PrivateKey` and `createWebCryptoSigner`.
- `deriveEngineId` and `defaultHostname`; the engine domain is configuration (`PTBK_ENGINE_DOMAIN`, spec Interface 6).
- The engine fingerprint with `deriveEngineFingerprint(engineId)` ([identity-and-registration.md](identity-and-registration.md#engine-fingerprint)): its `formatted` code is what the engine prints at first start and shows on its setup page, and what the dashboard shows, so the owner can compare them. Check it against [`fingerprint-vectors.json`](../../packages/protocol/src/fingerprint-vectors.json).
- A command that prints `{ engineId, enginePublicKey, hostname }` as JSON, like the mock engine's `identity` command. Our test stacks call it to write the relay's static registry, so keep that exact shape.

**Prove:**

- Unit tests: a second start loads the same key; a concurrent first start does not overwrite it; a group-readable key file, a foreign-owned directory and a symlinked key file each refuse to start with the path and mode in the error and no key material; the runtime key is not extractable.
- `registration.data-dir.private`, `registration.key-file.private`, `registration.key-file.loose-modes-refused` and `registration.identity.stable-across-restarts` (they run with phase 2's registration in place).
- `engine-api.engine.id-matches-key` once the API exists (phase 7).
- Checklist: ENG-10, ENG-11, ENG-15.

**Reference:** [fs-identity-store.ts](../../apps/mock-engine/src/adapters/fs-identity-store.ts), [private-files.ts](../../apps/mock-engine/src/adapters/private-files.ts), [engine-identity.ts](../../apps/mock-engine/src/domain/identity/engine-identity.ts), [identity.ts](../../apps/mock-engine/src/identity.ts).

**Pitfalls:** SHA-256 over the raw 32 key bytes, not over the base64url text; the key must never be the TLS key or the ACME account key; a key that exists but cannot be read is an error, never a reason to generate a new one.

## Phase 2: registration

**Read:** [identity-and-registration.md](identity-and-registration.md#registration) (Registration, Errors and re-registration, Configuration, [Launch contract](identity-and-registration.md#launch-contract)), [installation.md](installation.md#first-start-output) (First-start output, Operator commands), the [registration open points](README.md#open-points) (item 4).

**Build:**

- `POST REGISTER_PATH` to the dashboard API with a body from `signRegistration`, through `HTTPS_PROXY` and `NO_PROXY`, within `REGISTER_REQUEST_MAX_BYTES`.
- Read the answer with `TolerantRegisterEngineResponse` within `REGISTER_RESPONSE_MAX_BYTES`, then `checkRegistrationResponse`; map every problem code in the errors table to the behaviour it names.
- Store the registration durably in `PTBK_DATA_DIR`; on every start, check the stored one again against the key and the engine domain; make no network call when one is stored.
- Report each first-start step the way [installation.md](installation.md#first-start-output) requires (identity with the engine ID, default hostname and fingerprint code; registration; relays; certificate; UI bundle; owner; ready), map every registration problem `code` to its sentence and next step, and never print what that section forbids. The platform's onboarding depends on that output. The [operator commands](installation.md#operator-commands) (`connect --link`, `setup-link`, `status`, `owner --reset`, `reset --identity`) come with it; their names are suggestions, their behaviour is normative.
- Take the link code once from configuration, never store or log it, and drop it after the request. The mock engine reads `PTBK_DASHBOARD_URL` and `PTBK_LINK_CODE` and has `connect --link <code>`, the operator command from installation.md, plus `register --link <code>`, the same as `connect --json`, which prints one JSON outcome. Our dev stack and e2e call `register`, so offering the same output saves you a harness change (see [testing-against-the-platform.md](testing-against-the-platform.md#engine-settings-the-harness-uses)).

**Prove:**

- Golden vector: the `registration` case in [`signed-message-vectors.json`](../../packages/protocol/src/signed-message-vectors.json). Rebuild the signing input from its fields and compare the bytes; verify the signature with `verifyEd25519`.
- Unit tests for each error code, for a response with an engine ID the key does not derive and a hostname outside the engine domain (both refused, nothing stored), and for a body over the size cap.
- The conformance `registration` suite, which starts the engine with `--engine-cmd` and plays the dashboard: `registration.request.signature-verifies`, `registration.identity.engine-id-derived`, `registration.link-code.used-once`, `registration.secrets.never-logged`, `registration.response.unknown-fields-ignored`, `registration.response.invalid-refused` and one `registration.errors.*` check per problem code (`invalid-link-code`, `engine-exists`, `engine-suspended`, `not-entitled`, `rate-limited`, `unavailable`). The errors checks expect no tight retry loop (one attempt for final codes, at most three in 10 s for `rate-limited` and 5xx), the problem `code` named in the output, and nothing stored.

  ```sh
  node "$PLATFORM_DIR/packages/conformance/dist/ptbk-conformance.js" \
    --engine-cmd "<your engine's start command>" --engine-cwd "<directory to run it in>" \
    --suite registration --report junit --out registration-report.xml
  ```

  The local stack's dashboard then shows the same registration in a browser ([testing-against-the-platform.md](testing-against-the-platform.md#b-the-local-dev-stack)).

- Checklist: ENG-12, ENG-13, ENG-14, ENG-16.

**Reference:** [register.ts](../../apps/mock-engine/src/domain/registration/register.ts), [establish-registration.ts](../../apps/mock-engine/src/app/establish-registration.ts), [fs-registration-store.ts](../../apps/mock-engine/src/adapters/fs-registration-store.ts), [fetch-dashboard-api.ts](../../apps/mock-engine/src/adapters/fetch-dashboard-api.ts), [https-fetch.ts](../../apps/mock-engine/src/adapters/https-fetch.ts).

**Pitfalls:** the version part of the signing input is the decimal string `"1"` and the public key part is raw bytes; `engine-exists` and `engine-suspended` must not be retried; a lost `registration.json` with the key kept re-registers idempotently with a new link code and gives the same engine ID.

## Phase 3: heartbeat

**Read:** [heartbeat.md](heartbeat.md) (the whole page).

**Build:** the 60-second loop with `buildHeartbeat` and `signHeartbeat` over the exact bytes sent, `seq` persisted before sending, the figures rounded by `buildHeartbeat`, the failure table, and the last body, its signature header and the clock skew kept for `GET /security`.

**Prove:**

- Golden vector: the `heartbeat` case in [`signed-message-vectors.json`](../../packages/protocol/src/signed-message-vectors.json) (body bytes, digest, signing input, header).
- Unit tests: `seq` after a crash between persisting and sending is still higher; a `stale-timestamp` answer with `serverTime` records the skew; `replayed-seq` moves `seq` forward; failures are not retried or backfilled.
- `engine-api.security.heartbeat-body` once the API exists (phase 7).
- The conformance `heartbeat` suite (acting as the dashboard): `heartbeat.signature.verifies` (the first beat within 30 s of start), `heartbeat.body.strict`, `heartbeat.seq.increasing-across-restarts`, `heartbeat.cadence.interval` (the real 60 s; it skips when `--heartbeat-interval-s` overrides it, so run it once without), `heartbeat.errors.keeps-sending` and `heartbeat.stale-ts.skew-shown`. Same command as phase 2 with `--suite heartbeat`; `heartbeat.stale-ts.skew-shown` reads the security panel, so it needs `--engine-session-cmd` and `--engine-ca-file` (phase 9's command) and the API from phase 7.
- Checklist: ENG-40 to ENG-43.

**Reference:** [build-heartbeat.ts](../../apps/mock-engine/src/domain/heartbeat/build-heartbeat.ts), [heartbeat-loop.ts](../../apps/mock-engine/src/domain/heartbeat/heartbeat-loop.ts), [fs-seq-store.ts](../../apps/mock-engine/src/adapters/fs-seq-store.ts), [os-system-stats.ts](../../apps/mock-engine/src/adapters/os-system-stats.ts).

**Pitfalls:** keep 60 s as the interval; the local stacks accept it (a shorter development setting is an optional convenience, see [testing-against-the-platform.md](testing-against-the-platform.md#b-the-local-dev-stack)); never re-serialise the body after signing; the digest goes into the signing input as 32 raw bytes, not hex; the heartbeat goes straight to the dashboard, never through a relay; the body is numbers only, so no agent names or versions of anything but the engine.

## Phase 4: tunnel client

**Read:** [tunnel-client.md](tunnel-client.md) from Dialling to Liveness, the tunnel [open points](README.md#open-points) (item 1).

**Build:** one independent link per relay from the registration, WSS on `TUNNEL_PATH` with `TUNNEL_SUBPROTOCOL`, relay certificate verified for the relay hostname (also through a `CONNECT` proxy), the handshake with `signTunnelAuth` and `checkTunnelReady`, the close-code policy, frames with `encodeFrame` and `decodeFrame`, flow control with `createSendWindow` and `createReceiveWindow`, pings every `PING_INTERVAL_MS`, reconnect with full-jitter backoff. Each stream becomes a duplex the TLS server reads from in phase 5. The tunnel suite runs its fake relays on loopback ports, which the registration's bare relay hostnames cannot express, so it sets `PTBK_RELAYS`: when it is set, the engine dials exactly those relays instead of the registration's ([launch contract](identity-and-registration.md#launch-contract)).

**Prove:**

- Golden vectors: [`tunnel/vectors.json`](../../packages/protocol/src/tunnel/vectors.json). The signed handshake reproduces part by part; every `auth` that must not verify fails `verifyTunnelAuth`; every `ready` that must fail `checkTunnelReady` makes your client close with `PROTOCOL_ERROR`; every frame decodes to the recorded `frame`, `ignored` or `invalid`.
- Unit tests: a challenge for another relay is never signed (`wrong-relay`); `REPLACED` stops that relay's link; `SHUTTING_DOWN` reconnects soon; `DATA` beyond the granted credit closes the stream with `FLOW_CONTROL`; a stream ID reused or never opened closes the tunnel.
- The conformance `tunnel` suite, acting as every relay the engine dials: `tunnel.dial.*` (WebSocket upgrade, every relay, relay certificate), `tunnel.auth.*` (signature, fresh nonce, `version`, list encoding, wrong relay refused), `tunnel.negotiation.downgrade-refused`, `tunnel.handshake.invalid-message-refused`, `tunnel.stream.*` (TLS through the tunnel, unknown SNI, concurrent streams, `CLOSE`), `tunnel.flow.*`, `tunnel.frames.*`, `tunnel.reconnect.*` (after closes and rejects, backoff, `REPLACED` without a loop, relay restart), `tunnel.liveness.ping` and `tunnel.proxy.connect`. Same command as phase 2 with `--suite tunnel`. `tunnel.stream.tls-through-tunnel` needs phase 5's TLS server, and with `--engine-ca-file` it also verifies the certificate chain.
- Checklist: ENG-20 to ENG-29.

**Reference:** [relay-link.ts](../../apps/mock-engine/src/domain/tunnel/relay-link.ts), [backoff.ts](../../apps/mock-engine/src/domain/tunnel/backoff.ts), [ws-relay-dialer.ts](../../apps/mock-engine/src/adapters/ws-relay-dialer.ts), [http-connect-proxy.ts](../../apps/mock-engine/src/adapters/http-connect-proxy.ts), [stream-mux.ts](../../apps/mock-engine/src/domain/tunnel/stream-mux.ts), [tunnel-duplex.ts](../../apps/mock-engine/src/adapters/tunnel-duplex.ts), and the in-test relay and proxy in [`src/testing/`](../../apps/mock-engine/src/testing/).

**Pitfalls:** list encoding is part of the signature (numeric order for versions, byte order for features); the relay ID to compare is the one from your own relay list, never from the challenge; grant `WINDOW` credit only after the TLS server has read the bytes, in increments of at least 1 KiB; an operator CA is added to the default roots, never replaces them; WebSocket compression off.

## Phase 5: TLS inside the tunnel and certificates

**Read:** [tunnel-client.md](tunnel-client.md#ending-the-browsers-tls) (Ending the browser's TLS, Custom hostnames, ACME TLS-ALPN-01 through the relay), the ACME client [open point](README.md#open-points) (item 6).

**Build:**

- A ClientHello router in front of the TLS servers: `parseClientHello` reads SNI and ALPN from each stream, the bytes go back into the stream, and a hello offering exactly `acme-tls/1` for a hostname with a challenge pending goes to the challenge responder; every other `acme-tls/1` hello closes without a byte; everything else goes to the normal TLS server.
- The TLS server: TLS 1.3 only, certificate by SNI, no default certificate, renewals applied to new connections.
- ACME issuance with TLS-ALPN-01, an account key separate from the engine key, certificates in `PTBK_DATA_DIR` at 0600, ordering only once a tunnel is ready, renewal before expiry with backoff, and the ACME directory URL as configuration (`PTBK_ACME_DIRECTORY_URL` in the mock engine) so tests can point it at Pebble.
- Custom hostname claims with `signHostnameClaim` and the CNAME instructions from `expectedCnameTarget` (Enterprise; can come last).

**Prove:**

- Unit tests for the router decisions: `acme-tls/1` with and without a pending challenge, mixed with `h2`, without SNI, a non-TLS first byte, a hello that never completes.
- The e2e `acme` scenario against Pebble through the relays (task E-03; see [testing-against-the-platform.md](testing-against-the-platform.md#c-the-full-end-to-end-suite)). Before E-03, run your ACME client against a local Pebble with your own router in front.
- Checklist: ENG-30 to ENG-32.

**Reference:** [client-hello-router.ts](../../apps/mock-engine/src/adapters/client-hello-router.ts), [alpn-dispatch.ts](../../apps/mock-engine/src/domain/tls/alpn-dispatch.ts), [tls-alpn-responder.ts](../../apps/mock-engine/src/adapters/tls-alpn-responder.ts), [acme-certificate-source.ts](../../apps/mock-engine/src/adapters/acme-certificate-source.ts), [renewal-policy.ts](../../apps/mock-engine/src/domain/tls/renewal-policy.ts), [acme-account-key.ts](../../apps/mock-engine/src/adapters/acme-account-key.ts), [tls-stream-server.ts](../../apps/mock-engine/src/adapters/tls-stream-server.ts); the spike's result in [docs/spike/acme-tls-alpn-01.md](../spike/acme-tls-alpn-01.md).

**Pitfalls:** `acme-client@5.4.0`, which the mock uses for its Pebble spike, is unmaintained; choose the production client yourself. Engine hostnames can exceed 64 characters, so put them in SANs only, not the common name. Never log a key authorization, token or account URL. The relay resets a stream that gets no `DATA` from the engine within about 10 s of `OPEN`, so time out TLS handshakes yourself.

## Phase 6: the gateway

**Read:** [gateway.md](gateway.md) (the whole page), [engine-api.md](engine-api.md#permissions) (Permissions, Step-up), the spec's [Pairing and identity](../spec/zero-trust-spec.md#pairing-and-identity) (first setup with the setup secret, owner reset) and [Security hardening](../spec/zero-trust-spec.md#security-hardening) items 1 and 8. The onboarding flow and the setup link are in [installation.md](installation.md#the-setup-link).

**Build:**

- The gateway as the only listener behind the TLS server: Fetch Metadata and `Origin` checks on state-changing requests before anything else runs, session resolution, anonymous access limited to the sign-in page, the WebAuthn endpoints, `/setup` and public agents, 401 problem+json `unauthenticated` for anonymous API calls, a redirect to the sign-in page for anonymous documents that keeps the requested path as `next`.
- Passkeys only: WebAuthn registration and assertion on the engine's own hostname (the spec suggests SimpleWebAuthn; the platform pins `@simplewebauthn/*` versions you may align with).
- First setup: a 128-bit setup secret, single use, valid 30 minutes, printed only in the engine's terminal as `https://<hostname>/setup#<secret>`; the `/setup` page reads it from the fragment and registers the owner's passkey; the secret is refused from then on. An owner reset command that revokes every passkey and prints a fresh setup link.
- Server-side sessions: 128-bit IDs, `__Host-` cookie with `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, a new ID on every sign-in, idle and absolute timeouts, revocation within one request, a session API ID separate from the cookie, the passkey that signed each session in.
- Step-up: a fresh passkey assertion for `stepUp` routes, 401 `step-up-required` otherwise, `STEP_UP_PATH` with a return address.
- The security headers from [gateway.md](gateway.md#security-headers) on every response, `ENGINE_UI_CSP` byte for byte, and gateway pages without inline script or style.
- Rate limits on anonymous endpoints per client IP (the `OPEN` frame's address) and audit entries for `auth.*`, `passkey.*` and `session.*`.
- The [`conformance-session` command](identity-and-registration.md#conformance-sessions) (decided): only in the conformance build, behind the same build-time gate as `PTBK_CONFORMANCE_TRUST_FILE`, refused by production builds, never an HTTP endpoint. `--subject owner`, or `--subject member --permissions a,b` for a new member each time; it prints `{"cookie":"<name>=<value>"}`, `{"bearer":"…"}` or `null`. The conformance build also serves its certificates from a development CA it creates in `PTBK_DATA_DIR` and documents that file's path for `--engine-ca-file`.

**Prove:**

- `engine-api.auth.unauthenticated-401`, `engine-api.gateway.cross-site-refused`, `engine-api.gateway.sign-in-keeps-next`, `engine-api.me.own-sessions`, `engine-api.me.own-passkeys`, `engine-api.me.others-credentials-404` (commands in phase 7).
- Unit tests: a revoked session fails on the next request; the setup secret works once and not after 30 minutes; a cross-site `POST` gets 403 before any handler runs; every response carries every header, errors included.
- Checklist: ENG-90 to ENG-94, ENG-99.

**Reference:** the headers in [security-headers.ts](../../apps/mock-engine/src/domain/http/security-headers.ts) and how [http-app.ts](../../apps/mock-engine/src/adapters/http/http-app.ts) applies them after every handler and error; the Fetch Metadata and session logic in [gateway-middleware.ts](../../apps/mock-engine/src/adapters/http/gateway-middleware.ts) and [sessions.ts](../../apps/mock-engine/src/domain/gateway/sessions.ts). Passkey setup, sign-in and step-up in [passkey-gateway.ts](../../apps/mock-engine/src/domain/gateway/passkey-gateway.ts) and [passkey-routes.ts](../../apps/mock-engine/src/adapters/http/passkey-routes.ts), with the pages from [`packages/gateway-pages`](../../packages/gateway-pages/README.md). The mock's dev member picker ([dev-login.ts](../../apps/mock-engine/src/adapters/http/dev-login.ts)) is a test stand-in: never port it.

**Pitfalls:** the setup secret travels only in the URL fragment, so the page must read it client-side from a script file, not inline; a cookie that merely exists is not a session, resolve it on the server every time; compare session tokens and setup secrets as digests in constant time; `X-Forwarded-For` means nothing here, the client IP is the `OPEN` frame's; never add CORS.

## Phase 7: engine API v1 and capabilities

**Read:** [engine-api.md](engine-api.md) (the whole page), the engine API [open points](README.md#open-points) (item 2), the [conformance package README](../../packages/conformance/README.md) (what each check does to the engine).

**Build:**

- An `EngineApiTransport` that serves every route in `ENGINE_API_ROUTE_LIST` from the engine's domain, mounted with `createEngineApiHttpHandler` behind the gateway. The HTTP binding parses the query and body by media type; your transport validates params, query and body with the route's strict schemas, enforces the route's `permission` in one policy module, returns exactly the route's response schema and answers every error with `createProblem` and a code from `PROBLEM_CODES`.
- Start with the core groups (me, engine, agents, chats with SSE replies, secrets, security, audit, events, settings, API tokens, passkeys, sessions, folders, members, activity). Answer `draft` routes with 404 `not-found` if you have no behaviour for them.
- Then the capabilities you choose to ship (`runs@1`, `files@1`, `triggers@1`, `integrations@1`), each advertised in `GET /engine` only when all its routes work; every route of an unadvertised one answers 404 `capability-not-supported`.
- The audit hash chain covering every field, `target.name` and `details` included, and `GET /audit/verify`.
- Optional: a conformance target module that runs your `conformance-session` command (phase 6), for runs against an engine you started yourself; [testing-against-the-platform.md](testing-against-the-platform.md#against-a-running-engine-the-engine-api-suite-on-its-own) has one.

**Prove:** the full `engine-api` suite. The harness starts your conformance build, registers it and reaches its API through its fake relay, so nothing else needs to run, only registration, heartbeat and the tunnel client from the earlier phases:

```sh
node "$PLATFORM_DIR/packages/conformance/dist/ptbk-conformance.js" \
  --engine-cmd "<start command of your conformance build>" --engine-cwd "<directory to run it in>" \
  --engine-session-cmd "<your engine> conformance-session" \
  --engine-ca-file "{dataDir}/<path of its development CA certificate>" \
  --suite engine-api --report junit --out engine-api-report.xml
```

While you build the gateway, `--no-gateway` skips the gateway check. To iterate against an engine you run yourself, on a local listener or through the local stack's relay, the suite also takes `--base-url` with a target module ([testing-against-the-platform.md](testing-against-the-platform.md#against-a-running-engine-the-engine-api-suite-on-its-own)).

- Use `--filter <text>` while you work on one group, and the full suite before you move on. `--seed <n>` repeats a run.
- Every check in the [checklist](checklist.md)'s Engine API and route group tables passes. The only allowed skips are `capability-not-advertised`, `engine-api.cross-member.private-resources` in a harness run (only a target module can name that policy) and checks your target cannot serve yet, each listed in your report.
- Checklist: ENG-60 to ENG-87.

**Reference:** the mock serves this API with no hand-written route: [api-routes.ts](../../apps/mock-engine/src/adapters/http/api-routes.ts) on [`@ptbk/engine-api/http`](../../packages/engine-api/src/http.ts). The behavioural reference for every route is the in-memory engine, [in-memory/handlers.ts](../../packages/engine-api/src/in-memory/handlers.ts); its paging, audit chain and permission check are in the same folder. The role policy guess is [policy.ts](../../apps/mock-engine/src/domain/authorization/policy.ts).

**Pitfalls:**

- `GET /engine` must report the hostname the request came in on, so the base URL must use the engine's real hostname, not `localhost`. Names under `.localhost` resolve to loopback on most systems, which is how our CI does it (`<engineId>.engine.localhost`); where they do not, add the name to `/etc/hosts`.
- Every request from the suite carries `Origin` and `Sec-Fetch-Site: same-origin`; a gateway that refuses those refuses the suite.
- Strict responses: an extra field anywhere fails `engine-api.schemas.responses-strict`. Build responses from the contract types, not from your database rows.
- `engine-api.secrets.never-returned` looks for a canary value in every GET route and the event stream, raw, hex and base64. Secrets never go into audit `details`, events or errors.
- Denials must change nothing and must be audited with outcome `denied`.
- Nobody owns a thread: every member with `chats.write` writes in any thread, as the User, and the message names the member who sent it (`engine-api.cross-member.shared-threads`).

## Phase 8: UI loader

**Read:** [ui-loader.md](ui-loader.md) (the whole page, especially [Testing the loader: conformance build](ui-loader.md#testing-the-loader-conformance-build) and its [open points](ui-loader.md#open-points-decided-2026-10-26)), the release log [open points](README.md#open-points) (item 3), [cryptography.md](cryptography.md#what-the-engine-must-do).

**Build:** fetching the release record and the revocation list with timeouts and size caps, `verifyRelease` with the persisted `firstSeenAt` and `lastAcceptedRevocationIssuedAt`, the provenance adapter (use `createSigstoreProvenanceVerifier` from [`@ptbk/release-tools`](../../packages/release-tools/README.md) with its pinned trusted root rather than writing your own), the artifact's SHA-256, the safe unpacker, `verifyManifestFiles` and `satisfiesEngineApiRange`, atomic activation, keeping the previous bundle, serving only listed files with the SPA fallback outside `ENGINE_RESERVED_PATHS`, the update policy (`PTBK_UPDATE_POLICY`, `PTBK_PINNED_VERSION`), and `GET /security` → `ui`.

**Prove:**

- Golden vectors: [`release/vectors.json`](../../packages/protocol/src/release/vectors.json) through your fetch-and-verify path, not only through `verifyRelease`.
- Unit tests: a tarball with `..`, a symlink or a duplicate path is refused; an unlisted file is refused; a lost state file restarts the delay and is logged as an error; a missing, expired or rolled-back revocation list keeps the current bundle.
- The conformance `ui-loader` suite, acting as the release store, against your conformance build: install, strict Ed25519 for every case class, the signature threshold, DSSE PAE, strict payloads, exact provenance identity and log entry, the delay from trusted time persisted across restarts, artifact hashes, manifests, unsafe archives, the `engineApi` range, downgrades, every revocation case including a revoked active bundle, an unavailable store, the update policy, served files and headers ([checklist](checklist.md#ui-loader-interface-5)). It reads `GET /security`, so it needs phase 9's command with `--suite ui-loader`. A slow engine raises the per-check timeout with `--timeout-ms`.
- Checklist: ENG-50 to ENG-55.

**Reference:** [ui-update.ts](../../apps/mock-engine/src/domain/ui/ui-update.ts) (the part to port), [fs-bundle-store.ts](../../apps/mock-engine/src/adapters/ui/fs-bundle-store.ts), [bundle-unpacker.ts](../../apps/mock-engine/src/adapters/ui/bundle-unpacker.ts), [fs-update-state-store.ts](../../apps/mock-engine/src/adapters/ui/fs-update-state-store.ts), [http-release-source.ts](../../apps/mock-engine/src/adapters/ui/http-release-source.ts), [static-route.ts](../../apps/mock-engine/src/domain/ui/static-route.ts), [ui-routes.ts](../../apps/mock-engine/src/adapters/http/ui-routes.ts).

**Pitfalls:**

- **The conformance build** ([ui-loader.md](ui-loader.md#testing-the-loader-conformance-build), decided). The suite mints real Sigstore-format bundles under an ephemeral trust root, so the engine must be able to load a test trust policy and trusted root, and only in a build made for it: a compile-time constant (for example `PTBK_CONFORMANCE_BUILD`), false in release builds so the code path is removed, enables reading `PTBK_CONFORMANCE_TRUST_FILE` (`{ v: 1, trustPolicy, trustedRoot }`, parsed strictly), which replaces the pinned trust policy and trusted root and nothing else. A production build that sees the variable set refuses to start and names it. The engine's release workflow asserts the constant is off. Never read a trust root or key from the environment in any other way, and never build a fake-provenance mode like the mock's `MOCK_UI_FAKE_PROVENANCE`.
- **The [release mirror layout v1](ui-loader.md#release-mirror-layout-v1)** (adopted, open for your review before the freeze): `ui/latest.json`, `release-log/ui-<version>.json`, `release-log/revocations.json` and `ui/<version>/<artifact name>` below `PTBK_UI_RELEASE_URL`. Keep the fetcher behind a port anyway.
- **A revoked active bundle stops being served** once an accepted list names it: the previous bundle comes back if it is not revoked, otherwise the plain engine page.
- Never read the manifest's `csp`; the engine's headers are engine code.
- Find the UI artifact by `kind: 'ui'`, not by name.

## Phase 9: the whole engine against our stack

**Read:** [testing-against-the-platform.md](testing-against-the-platform.md) (the whole page).

**Build:** nothing new. Package the engine the way customers will run it (the spec's main channel is a signed Docker image), with every setting from [the harness table](testing-against-the-platform.md#engine-settings-the-harness-uses) configurable.

**Prove:**

- The conformance run from [AGENT_BRIEF.md](AGENT_BRIEF.md#when-you-are-done), with no failure: every suite, in one command that starts your conformance build itself,

  ```sh
  node "$PLATFORM_DIR/packages/conformance/dist/ptbk-conformance.js" \
    --engine-cmd "<start command of your conformance build>" --engine-cwd "<directory to run it in>" \
    --engine-session-cmd "<your engine> conformance-session" \
    --engine-ca-file "{dataDir}/<path of its development CA certificate>" \
    --suite engine-api,registration,heartbeat,tunnel,ui-loader \
    --report junit --out conformance-report.xml
  ```

  Run it without any heartbeat interval override, so `heartbeat.cadence.interval` proves the production 60 s.

- The local stack with your engine in place of the mock: link with a link code, online in the dashboard, open through the relay, sign in with a passkey, no CSP violation in the browser console. Serving the UI there, and chatting with an agent in it, waits for E-03, which re-signs the stack's UI releases for a conformance build.
- _Pending E-03:_ the full e2e suite with `ENGINE_IMPL=real`: spike network tests (NAT, 443 only, `CONNECT` and TLS-inspecting proxies, relay restart and failover, packet capture), ACME through the relay, the UI flows under the strict CSP, and the dashboard flow.
- Every row in [checklist.md](checklist.md) is done or listed in your report with its reason.

**Pitfalls:** see the [troubleshooting table](testing-against-the-platform.md#troubleshooting).
