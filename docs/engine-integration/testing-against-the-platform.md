# Testing the engine against the platform

Three ways to test the real engine against our side, from the fastest to the most complete. None of them needs a credential from us: no account, no token, no key. Everything runs on your machine from a checkout of the platform repository (`$PLATFORM_DIR`, set up in [implementation-plan.md](implementation-plan.md#phase-0-setup-and-contracts)).

| Way                                                           | What it proves                                                                     | Needs                   | Status                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| [(a) The conformance CLI](#a-the-conformance-cli)             | Each contract on its own, check by check, with a report                            | Node 24                 | `engine-api` suite works; the other suites pending C-08 to C-10 |
| [(b) The local dev stack](#b-the-local-dev-stack)             | The engine with our real dashboard and relays, clicked through in your own browser | Docker or OrbStack, Bun | Works for registration, heartbeat and tunnel; the UI pending    |
| [(c) The full end-to-end suite](#c-the-full-end-to-end-suite) | Everything, including NAT, proxies, failover, ACME and the UI flows under the CSP  | Docker or OrbStack, Bun | Pending E-03                                                    |

## (a) The conformance CLI

Build it once in the platform checkout; it is one file that runs on Node 24 with no `node_modules`:

```sh
(cd "$PLATFORM_DIR" && bun run --filter @ptbk/conformance build)
node "$PLATFORM_DIR/packages/conformance/dist/ptbk-conformance.js" --help
```

[conformance.md](conformance.md) describes the flags and the report, and the [package README](../../packages/conformance/README.md) what every check does to the engine. The exit code is 0 only when no check failed.

### Against a running engine: the `engine-api` suite

This works today. Start your engine so that its gateway answers on its real hostname, then point the suite at it:

```sh
NODE_EXTRA_CA_CERTS=<CA that issued the engine's certificate> \
node "$PLATFORM_DIR/packages/conformance/dist/ptbk-conformance.js" \
  --base-url "https://<engineId>.engine.localhost:8443" \
  --target-module ./conformance-target.mjs \
  --engine-public-key "<enginePublicKey>" \
  --report junit --out conformance-report.xml
```

- **Hostname.** `GET /engine` must report the hostname the request came in on, so use the engine's own hostname, not `localhost`. Names under `.localhost` resolve to loopback on most systems (our CI relies on it), so an engine domain of `engine.localhost` needs no DNS; where they do not, add the name to `/etc/hosts`. While you build the API, the gateway can listen on a local port in `local` mode; once the tunnel works, run the same command through a relay ((b) gives you one).
- **Sessions.** The target module gives the suite an owner session and members with chosen permissions. How a passkey-only engine does that is still an [open point](conformance.md#sessions-on-a-real-engine). For a first run, set `PTBK_CONFORMANCE_OWNER_COOKIE=<name>=<value>` to a session cookie you copied from a browser, **instead of** `--target-module` (the CLI refuses both at once): the owner checks run and member checks skip.
- **Iterating.** `--filter <text>` runs only the checks whose ID contains the text; `--seed <n>` repeats a run's names and values; `--suite tunnel` and `--suite ui-loader` list their checks, which report `skip` until their suites merge.
- **What it leaves behind.** Every resource it creates is named `conformance-<runId>-…` and removed after each check, except chats, which the API cannot delete. Run it against a test engine.

### With `--engine-cmd`: registration, heartbeat, tunnel and UI loader

_Pending C-08 (harness, registration, heartbeat), C-09 (tunnel) and C-10 (UI loader). This section follows their briefs; once they merge, the [package README](../../packages/conformance/README.md) and [conformance.md](conformance.md) are authoritative._

With `--engine-cmd`, the CLI starts the engine itself, in a fresh data directory, and plays every peer the engine talks to on loopback, so it can send what a real peer never would:

```sh
node "$PLATFORM_DIR/packages/conformance/dist/ptbk-conformance.js" \
  --engine-cmd "<your engine's start command>" --engine-cwd "<directory to run it in>" \
  --suite registration --suite heartbeat --report junit --out platform-report.xml
```

- **C-08: the harness, `registration` and `heartbeat`.** The CLI acts as the dashboard API with real link code semantics, scripted error answers and a request log. It checks the signed request, the engine ID, the data directory and key file modes (and that loose modes refuse to start), that the link code and key never reach the output or the disk, the tolerant and the refused responses, one check per problem code, and the heartbeat's signature, body, `seq` across restarts, 60 s cadence and reaction to errors. `--heartbeat-interval-s <n>` runs the other heartbeat checks faster with your own development setting; the cadence check then skips, so run once without it.
- **C-09: `tunnel`.** The CLI acts as a relay: it sends unsorted version and feature lists, a challenge for another relay, a downgraded `ready`, every close code and invalid frames, and checks what the engine signs, sends and does next.
- **C-10: `ui-loader`.** The CLI acts as the release store, serving the release mirror layout v1: releases signed with each `ed25519-vectors.json` case, payloads changed after signing, wrong provenance identities, backdated `publishedAt`, unsafe archives, and expired, rolled-back or revoking lists. It restarts the engine with `PTBK_UPDATE_POLICY=pinned` and `PTBK_PINNED_VERSION`, and reads what `GET /security` reports and which files the engine serves. It runs against the engine's **conformance build**, the only build allowed to read `PTBK_CONFORMANCE_TRUST_FILE`, because the suite's releases are signed under an ephemeral Sigstore trust root ([implementation-plan.md](implementation-plan.md#phase-8-ui-loader)).

**The launch contract.** The harness removes `HTTPS_PROXY`, `NO_PROXY` and every inherited `PTBK_*` variable from the engine's environment and sets its own (the [harness table](#engine-settings-the-harness-uses)). Development settings of your own go into the command itself (`env MY_SETTING=1 node dist/server.mjs`). The engine must create `PTBK_DATA_DIR` itself, log to stdout or stderr, exit non-zero when it refuses to start, and exit within 10 s of SIGTERM. A failed check's report carries the end of the engine's output.

## (b) The local dev stack

The whole platform on one machine (the dashboard, two relays, a release store and the mock engine), kept across restarts, reachable from your own browser with a real passkey. [docs/development.md](../development.md#local-stack) is the full guide; the short version:

```sh
cd "$PLATFORM_DIR"
bun run dev:stack up     # builds, creates the dev CA in .dev/pki/, starts everything, prints the URLs
bun run dev:trust        # once per machine: trust the dev CA and resolve app.ptbk.test and *.engine.test
```

Open `https://app.ptbk.test:8444/`, sign up (the e-mail is on `https://app.ptbk.test:8444/__dev/mailbox`), subscribe through the fake Checkout under Billing, and create a link code on "Link an engine". Codes last 30 minutes.

**First, watch the mock engine do it.** `bun run dev:link <code>` registers the stack's mock engine and starts it. It turns online after its first heartbeat (every 15 s in this stack); "Open" goes to `https://<engineId>.engine.test/` through relay-a. That is the behaviour your engine must reproduce. `bun run dev:stack reset` starts over with a new dashboard database and a new mock engine.

**Then run your engine in its place.** The stack starts the mock engine only once it is linked, so with a fresh link code your engine can take its place. Run it as a container on the stack's network, so it resolves the relays and the dashboard the way the mock does:

```sh
STACK_DNS="$(docker inspect -f '{{(index .NetworkSettings.Networks "ptbk-dev_stack").IPAddress}}' ptbk-dev-dns-1)"
docker run --rm --name my-engine \
  --network ptbk-dev_stack --dns "$STACK_DNS" \
  -v "$PLATFORM_DIR/.dev/pki/dev-ca/ca-cert.pem:/pki/dev-ca.pem:ro" \
  -e NODE_EXTRA_CA_CERTS=/pki/dev-ca.pem \
  -e PTBK_MODE=tunnel -e PTBK_DATA_DIR=/data \
  -e PTBK_ENGINE_DOMAIN=engine.test \
  -e PTBK_DASHBOARD_URL=https://app.ptbk.test:8444 \
  -e PTBK_LINK_CODE=<code> \
  -e <your engine's heartbeat interval setting>=15 \
  -v my-engine-data:/data \
  <your engine image>
```

- `STACK_DNS` is the address of the stack's resolver (the `dns` service). It answers for `app.ptbk.test`, `relay-a.ptbk.test`, `relay-b.ptbk.test` and `releases.ptbk.test`. The dev CA signed all their certificates, so the engine trusts them through `NODE_EXTRA_CA_CERTS` added to its default roots.
- The registration's relays are `relay-a.ptbk.test` and `relay-b.ptbk.test`. Both relays look your engine up in the dashboard's registry, so nothing else needs configuring.
- **Heartbeat interval.** The stack's dashboard expects a beat every 15 s and marks an engine offline after 35 s without one; the mock is set to 15 s for it. An engine on the production 60 s flips offline for part of every minute, so give it a development setting for the interval (the mock's is `MOCK_HEARTBEAT_INTERVAL_S`) and set it to 15 here. It is not part of the contract, and the conformance cadence check runs at 60 s.
- **Outside names.** The stack's resolver refuses every name outside the test domains, so an engine that calls an external model provider to answer a chat fails inside the stack. Use a local or fake model provider for the click-through.
- **Starting over.** `bun run dev:stack reset` drops the dashboard's database but not your engine's volume. Remove `my-engine-data` too, or the engine keeps its old registration, makes no registration call, and gets 404 `not-found` for its heartbeats and close code 4001 from the relays.
- What this proves today: registration (ENG-12, ENG-13), heartbeats and the online status (ENG-40 to ENG-43), and tunnels to both relays (ENG-20 to ENG-29). `bun run dev:stack logs relay-a relay-b dashboard` shows the platform's side.
- **Opening it in a browser.** The browser trusts the dev CA, but nothing in the stack issues a certificate for your engine's hostname: the mock issues its own from the dev CA's key, and there is no ACME server in the dev stack. Until E-03 adds one, run the stack with `bun run dev:stack up --no-system` and use the Chrome profile it prints, which ignores certificate errors and still allows WebAuthn; your engine may then use any certificate for `<engineId>.engine.test`. That profile reaches relay-a on 127.0.0.1:8443 through its resolver rules; the engine still dials the relays inside the stack's network.
- **The UI bundle.** The stack's release store serves UI releases signed with test attestations that only the mock engine accepts. A real engine refuses them, correctly, and serves its plain page; even its conformance build cannot take them, because they carry no Sigstore bundle. Until E-03 signs the stack's releases the way C-10's suite does, the dev stack proves everything up to the gateway and the API, not the UI.

## (c) The full end-to-end suite

_Pending E-03._ The platform's e2e suite runs real browsers through the relays to an engine in Docker Compose, scenario by scenario ([docs/development.md](../development.md#end-to-end)): `spike` (WebSockets and SSE through the passthrough, the UI loader), `nat` (NAT, packet capture, relay restart and failover, no engine key on a relay), `egress-443`, `connect-proxy`, `tls-inspecting-proxy`, `acme` (TLS-ALPN-01 through the relay against Pebble), `dashboard` (sign up, link, online, open) and `ui` (every engine UI flow under the strict CSP).

```sh
cd "$PLATFORM_DIR"
bun run dev:stack down                               # the dev and e2e stacks share a subnet
E2E_SCENARIO=dashboard bun run --filter @ptbk/e2e e2e
```

Today every scenario runs the mock engine. E-03 adds `ENGINE_IMPL=real`, which runs your signed image pinned by digest with the settings in [the harness table](#engine-settings-the-harness-uses), registers it against the stack's dashboard with a link code, and skips the tests tagged `@mock-only` (fault injection and other mock levers), each with its reason in the e2e README. What the harness relies on from the mock today, and E-03 must replace or ask of your engine:

- An `identity` command that prints `{ engineId, enginePublicKey, hostname }` as JSON, for the scenarios that use a static relay registry.
- A `register --link <code>` command that prints a JSON outcome, for `dev:link` and the dashboard fixtures; or registration from `PTBK_LINK_CODE` at startup.
- The engine's own certificate: from the dev CA (mock only) or from ACME against the stack's Pebble (`PTBK_ACME_DIRECTORY_URL`, with Pebble's CA in `NODE_EXTRA_CA_CERTS`).
- Sessions for the UI tests: today from the mock's control listener, which a real engine does not have; E-03 uses the conformance target's answer.
- Waiting on the mock's log events and spike routes (`/__spike/`) in a few tests; E-03 replaces them with what a real engine shows.

## Engine settings the harness uses

The spec's [Interface 6](../spec/zero-trust-spec.md#interfaces-draft) fixes `PTBK_MODE`, `PTBK_UPDATE_POLICY`, `PTBK_PINNED_VERSION`, `PTBK_CUSTOM_DOMAIN`, `HTTPS_PROXY`, `NO_PROXY` and `PTBK_DATA_DIR`, and leaves the rest to the engine. Our test harnesses configure engines with the names below: C-08 fixes the conformance harness's launch contract (pending its merge), and the stacks use the mock engine's names. Using the same names lets every harness drive your engine unchanged; whether they become part of Interface 6 is an [open point](README.md#open-points).

| Variable                                    | Meaning in the harness                                                                                                                                                                                                                                                                            | Used by           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `PTBK_MODE`                                 | `tunnel`                                                                                                                                                                                                                                                                                          | Spec, Interface 6 |
| `PTBK_DATA_DIR`                             | A fresh directory, mode 0700                                                                                                                                                                                                                                                                      | Spec, Interface 6 |
| `PTBK_ENGINE_DOMAIN`                        | `engine.test` in the stacks, `engine.localhost` in CI and the harness                                                                                                                                                                                                                             | (b), (c), C-08    |
| `PTBK_DASHBOARD_URL`                        | The dashboard API's `https://` origin (`https://dashboard.localhost:<port>` in the harness); registration and heartbeats go there                                                                                                                                                                 | (b), (c), C-08    |
| `PTBK_LINK_CODE`                            | A one-time link code for the first registration                                                                                                                                                                                                                                                   | (b), (c), C-08    |
| `PTBK_RELAYS`                               | Comma-separated `wss://` relay URLs: the relay list of the mock's dev mode without a dashboard (CI); C-09 uses it to point an engine at fake relays on loopback ports, and fixes how it relates to the registration's relays                                                                      | CI, C-09          |
| `PTBK_UI_RELEASE_URL`                       | The release store, `https://` with a path ending in `/`                                                                                                                                                                                                                                           | (c), C-10         |
| `PTBK_UPDATE_POLICY`, `PTBK_PINNED_VERSION` | `pinned` with the test release's version in e2e                                                                                                                                                                                                                                                   | Spec, Interface 6 |
| `PTBK_ACME_DIRECTORY_URL`                   | The ACME directory, Pebble in the `acme` scenario                                                                                                                                                                                                                                                 | (c)               |
| Heartbeat interval                          | Not a contract setting; the stacks expect 15 s (mock: `MOCK_HEARTBEAT_INTERVAL_S`), C-08 takes `--heartbeat-interval-s` as an expectation                                                                                                                                                         | (b), (c), C-08    |
| `PTBK_CONFORMANCE_TRUST_FILE`               | Test trust policy and Sigstore trusted root; read only by a conformance build, refused by a production build                                                                                                                                                                                      | C-10              |
| `NODE_EXTRA_CA_CERTS`                       | The test CA, added to the default roots: for the dashboard, relays and release store in the conformance harness and the dev stack example above, and for Pebble in the `acme` scenario. The mock takes the same CA through its own `MOCK_EXTRA_CA_FILE` in the stacks; E-03 maps one to the other | (b), (c), C-08    |
| `HTTPS_PROXY`, `NO_PROXY`                   | The proxy scenarios                                                                                                                                                                                                                                                                               | Spec, Interface 6 |

## Troubleshooting

| Symptom                                                          | Likely cause                                                                                                                                          | What catches it                                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Registration answers 401 `bad-signature`                         | The signing input is built by hand: `v` as a number instead of `"1"`, the public key as its base64url text instead of 32 raw bytes                    | The `registration` golden vector; `registration` suite (pending C-08)                           |
| Registration answers 401 `invalid-link-code`                     | The code expired (30 minutes in the dev stack, 30 s in e2e) or was used                                                                               | Nothing: ask for a new code                                                                     |
| Registration answers 403 `not-entitled`                          | The account has no subscription; in the dev stack, the fake Checkout is lost on `down`                                                                | Nothing: subscribe again                                                                        |
| Registration answers 409 `engine-exists`                         | The same key (data directory) was linked before with a code from another account in the same dashboard                                                | Nothing: use a fresh data directory, or a code from the first account                           |
| Heartbeats get 404 `not-found` and tunnels close with 4001       | The dashboard was reset but the engine kept its stored registration, so it never registered again                                                     | Nothing: remove the engine's data directory as well                                             |
| Engine refuses the registration answer                           | `checkRegistrationResponse` failed: wrong engine domain configured                                                                                    | Unit tests; `registration` suite (pending C-08)                                                 |
| Heartbeat answers 401 `bad-signature`                            | The body was re-serialised after signing, or the digest went in as hex text                                                                           | The `heartbeat` golden vector; `heartbeat` suite (pending C-08)                                 |
| Heartbeat answers 401 `stale-timestamp`                          | The engine's clock is more than 2 minutes off                                                                                                         | `GET /security` → `clockSkew`; `heartbeat` suite (pending C-08)                                 |
| Heartbeat answers 409 `replayed-seq`                             | `seq` is not persisted before sending, or the data directory was restored from a backup                                                               | `heartbeat` suite (pending C-08)                                                                |
| Tunnel connect fails with a certificate error                    | The test CA is not trusted for the relay (`NODE_EXTRA_CA_CERTS`), or the default roots were replaced instead of extended                              | Engine logs                                                                                     |
| Tunnel closes with 4001 right after `auth`                       | The engine is not in the relay's registry (not registered yet), or the signature is wrong: list encoding or the software `version`                    | `tunnel/vectors.json`; `tunnel.auth.list-encoding`, `tunnel.auth.version-signed` (pending C-09) |
| Tunnel closes with 4002                                          | An invalid frame, a text message after `ready`, or the engine accepted a `ready` that `checkTunnelReady` refuses                                      | `tunnel.negotiation.downgrade-refused` (pending C-09)                                           |
| Tunnels keep replacing each other (4000 `REPLACED`)              | Two processes hold the same engine key, or the engine reconnects after `REPLACED`                                                                     | `tunnel` suite (pending C-09)                                                                   |
| Tunnel closes with 4005 `FRAME_BUDGET`                           | Many tiny `WINDOW` grants or `DATA` frames                                                                                                            | `tunnel` suite (pending C-09)                                                                   |
| Online in the dashboard, but the browser gets a reset connection | The TLS server has no certificate for that SNI, or the handshake is not answered within about 10 s of `OPEN`                                          | e2e `spike` (pending E-03)                                                                      |
| ACME validation fails through the relay                          | `acme-tls/1` hellos are not routed to the responder, the order started before a tunnel was ready, or the challenge certificate lacks `acmeIdentifier` | e2e `acme` (pending E-03)                                                                       |
| The engine page is blank, or the console shows CSP violations    | Headers differ from `ENGINE_UI_CSP`, or a gateway page has an inline script or style                                                                  | e2e `ui`, zero CSP violations (pending E-03)                                                    |
| The engine serves its plain page instead of the UI               | No bundle installed: no fresh revocation list, test attestations, or an `engineApi` range the engine does not satisfy                                 | `GET /security` → `ui.lastUpdateCheck`; `ui-loader` suite (pending C-10)                        |
| Every conformance check fails with 403                           | The gateway refuses the suite's `Origin`, often because it compares without the port                                                                  | `engine-api.gateway.cross-site-refused` passes only once both directions are right              |
| `engine-api.engine.info` fails on the hostname                   | The base URL is not the engine's own hostname                                                                                                         | `engine-api.engine.info`                                                                        |
| `engine-api.schemas.responses-strict` fails                      | A response carries a field the contract does not declare, often straight from a database row                                                          | `engine-api.schemas.responses-strict`                                                           |
| Every member check skips                                         | The target module returns `null` for member subjects                                                                                                  | The report's skip reasons                                                                       |
| `engine-api.secrets.never-returned` fails                        | A secret value reached an audit entry's `details`, an event, an error or an integration response                                                      | `engine-api.secrets.never-returned`, `engine-api.integrations.secrets-never-returned`           |
