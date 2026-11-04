# Development

## Prerequisites

- [Bun](https://bun.sh) at the version pinned in `package.json` (`packageManager`). Bun is the package manager and script runner.
- Node 24 LTS (`nvm use` reads `.nvmrc`). The relay runs on Node in production, so tests and tooling run on Node too.

## Setup

```sh
bun install
```

This also points git at the hooks in `.husky/`: `pre-commit` runs ESLint and Prettier on staged files, and `commit-msg` runs commitlint.

## Commands

| Command                                 | What it does                                                            |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `bun run check`                         | Everything CI runs: generate, lint, format, types, tests, plan          |
| `bun run generate`                      | Generated code (Paraglide, route trees, wrangler types); not committed  |
| `bun run lint`                          | ESLint, type-aware                                                      |
| `bun run format`                        | Prettier, writes changes                                                |
| `bun run typecheck`                     | `tsc --noEmit` in every package                                         |
| `bun run test`                          | Vitest in every package                                                 |
| `bun run --filter @ptbk/relay <script>` | A script in one package                                                 |
| `bun run --filter @ptbk/e2e e2e`        | The browser e2e suite in Docker Compose (see [End to end](#end-to-end)) |
| `bun run dev:stack up`                  | The whole product on your machine (see [Local stack](#local-stack))     |

## Dependencies

Supply-chain rules (spec, Security hardening item 10):

- `bunfig.toml` refuses versions published less than **7 days** ago and saves **exact** versions. `bun.lock` is committed and CI installs with `--frozen-lockfile`.
- Install scripts run only for the packages listed in `trustedDependencies` in the root `package.json` (esbuild, sharp, workerd). Adding one is its own PR, approved by a human, with the reason.
- A third-party package used by more than one module is pinned once in the root workspace `catalog` and referenced as `"catalog:"`.
- Vitest is pinned to 4.1 repo-wide because Cloudflare's Workers test pool supports only that major; Dependabot ignores TypeScript, Vitest and `@types/node` majors until the toolchain catches up.
- The isolated linker makes undeclared transitive dependencies fail; declare everything you import.
- Dependabot opens weekly grouped updates with the same 7-day cooldown.
- Before adding a dependency, check whether Node, Workers or the Web platform already does the job.

Shared dev tooling (TypeScript, ESLint, Vitest) lives in the root `package.json`. Runtime dependencies go in the package that uses them: `bun add <pkg> --cwd apps/relay`.

## End to end

`e2e/` (`@ptbk/e2e`) runs real browsers through the relays to the mock engine. It needs Docker (Engine 25 or later) or OrbStack, with Compose v2.24 or later; nothing else is installed on the host, and `bun run check` never needs Docker (the package's `test` script covers only the harness helpers).

```sh
bun run --filter @ptbk/e2e e2e                 # every scenario in turn: start, test, stop; removes containers and volumes
E2E_SCENARIO=nat bun run --filter @ptbk/e2e e2e                # one scenario alone
E2E_SCENARIO=nat bun run --filter @ptbk/e2e e2e --grep restart  # extra arguments go to `playwright test`
```

The stack (`e2e/compose.yaml`, one network `10.89.231.0/24`):

| Service                | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init`                 | One-shot. Runs the mock engine's `identity`, `dev-ca` and `ui-test-release` CLIs: a fresh engine key, a fresh name-constrained dev CA (key 0600), a certificate per relay and for the release store, the relays' static registry file, and two engine-ui bundles packed by X-03's `pack` and signed with release keys that exist only while init runs (the second tampered with after signing). Every run starts from new volumes; nothing is committed |
| `relay-a`/`relay-b`    | `apps/relay` on port 443, each with only its own key; healthy when `/healthz` answers on its own hostname                                                                                                                                                                                                                                                                                                                                               |
| `relay-a-net`/`-b-net` | Hold each relay's address (`.11`, `.12`) and network namespace; the relay joins it. A killed relay's address stays up and refuses connections, as a crashed relay on a live host does                                                                                                                                                                                                                                                                   |
| `release-store`        | `.30`, `https://releases.ptbk.test/`: init's signed UI releases, read-only, in the layout the mock engine's loader reads                                                                                                                                                                                                                                                                                                                                |
| `mock-engine`          | `apps/mock-engine` at `.31` (behind the gateway in the `nat` overlays), dialling both relays and issuing its leaf from the dev CA; its UI loader installs the pinned release (test attestations instead of Sigstore) and serves it at `/`; control listener on port 4480                                                                                                                                                                                |
| `engine-probe`         | Does nothing but its healthcheck: healthy once the spike endpoint answers through every relay, seen from the browser's side of the network (the engine's own way out differs per scenario)                                                                                                                                                                                                                                                              |
| `dns`                  | CoreDNS (`e2e/coredns/Corefile`): `relay-a/b.ptbk.test`, `releases.ptbk.test`, and both relay addresses for every `*.engine.test` name (zone files in `e2e/coredns/zones/`, which the nat scenario's `relay-dns` replaces); everything else is refused                                                                                                                                                                                                  |
| `playwright`           | The official Playwright image, run as `pwuser` with Chromium's sandbox on; its entrypoint adds the dev CA to pwuser's NSS database. Runs the tests in `e2e/tests/`                                                                                                                                                                                                                                                                                      |

`.test` is reserved (RFC 6761): `ptbk.test` stands in for our domain and `engine.test` for the engine domain. The engine key and the dev CA key live in a volume only the mock engine mounts; the browser trusts the dev CA's certificate and sees the engine's own certificate through the relays.

The `playwright` container is still privileged on the Docker host: the `compose` fixture needs the Docker socket to stop, kill and pause services (X-02's failover tests), and access to that socket is root-equivalent. `cli.ts` reads the socket's group from inside Docker (it differs from the host's on macOS) and passes it as `E2E_DOCKER_GID` for `group_add`; without it the service gets `nogroup` and no access. What limits the exposure is that only the Node test process uses the socket: Chromium runs with its sandbox, and its renderers sit in their own namespaces under a seccomp filter, so a renderer bug in a page under test cannot reach it. `tests/harness/sandbox.spec.ts` fails if the browser ever runs as root or with `--no-sandbox`. The sandbox needs user namespaces, which Docker's default seccomp profile refuses, so the service uses Playwright's published profile (`e2e/docker/seccomp_profile.json`, copied unchanged from [microsoft/playwright@606ecd8 `utils/docker/seccomp_profile.json`](https://github.com/microsoft/playwright/blob/606ecd8b34bac100db32561b6278ffd76e5eb3cd/utils/docker/seccomp_profile.json), the v1.64.0 tag), not `SYS_ADMIN`. Refresh it together with the Playwright version.

Tests use the fixtures in `e2e/src/fixtures.ts`: `engineHost`, `engineUrl` (the app, behind the gateway), `spikeUrl` (the public spike page), `engineCertSha256` (what a verifying TLS client sees through every relay, required to be identical), `relayHosts`, `peerCertificate(page)` and `peerCertificateSha256(page)` (CDP), `requestLog`, `cspViolations` and `compose` (stop, start, kill, restart, pause, logs, health, exec, inspect, filesystem export and network disconnect of a service, through the Docker socket mounted into the `playwright` container). Wait with `expect.poll`, the healthchecks and the services' own log events (`src/service-events.ts`), never with sleeps.

### Debugging and logs

| Command                                         | What it does                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `bun run --filter @ptbk/e2e e2e:up`             | Builds and starts the stack, waits until every service is healthy, and leaves it running |
| `bun run --filter @ptbk/e2e e2e:run [args]`     | Rebuilds only the test image, then runs the scenario's tests against the running stack   |
| `bun run --filter @ptbk/e2e e2e:logs [service]` | Every service's logs, with timestamps                                                    |
| `bun run --filter @ptbk/e2e e2e:down`           | Stops the stack and removes its containers and volumes, whichever scenario started them  |

Each of them takes `E2E_SCENARIO` (default `spike`), so `E2E_SCENARIO=nat bun run --filter @ptbk/e2e e2e:up` starts the NAT topology and `e2e:run` then runs only its specs. After changing an app or `init`, run `e2e:up` again; after changing tests, `e2e:run` is enough.

Results land in `e2e/test-results/<scenario>/` (ignored by git): `report/index.html` (open it with `bunx playwright show-report e2e/test-results/nat/report`), traces and screenshots of failed tests in `artifacts/` (`bunx playwright show-trace <trace.zip>`), and, when anything failed, every service's log in `compose.log`. A failed packet-capture test also attaches relay-a's capture: only that test's traffic on port 443, ciphertext only, since nothing in the stack writes a TLS key log. CI uploads the same folder as the `e2e-results` artifact on failure. Logs carry no keys or content, by the relay's and mock engine's own rules.

Each checkout gets its own compose project (`ptbk-e2e-<directory>`, or `E2E_PROJECT`), so worktrees never drive each other's containers. The subnet is fixed, so only one e2e stack runs per Docker host at a time: a second `e2e:up` fails on the overlapping network instead of taking over the first. The [local dev stack](#local-stack) has a network of its own and runs next to it.

### Scenarios

A scenario is one run of the stack: `compose.yaml` plus overlays (`e2e/compose.<name>.yaml`, layered in order) and the specs that need exactly that topology (`e2e/src/scenarios.ts`). The network scenarios (X-02) put the mock engine on `engine-lan` (`10.89.232.0/24`), an internal network with no address on the host's bridge, so nothing can route into it; its only way out is `gateway` (`.2` on the LAN, `10.89.231.20` outside), whose rules and their reasons are in `e2e/gateway/gateway.sh`. The engine runs in the network namespace of `engine-net`, which sets the route and listens on 443 and 8080 so "nothing reaches the engine" is tested against open ports. Only `gateway` and `engine-net` get `NET_ADMIN`, and relay-a's capture only `NET_RAW` (as a file capability of tcpdump, run as nobody); the playwright service gets nothing new.

| Scenario               | Overlays                      | Specs                                                                                      | Spike criterion (spec, Build plan)                                                                                                            |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `spike`                | none                          | `tests/spike/`, `tests/harness/`                                                           | WebSockets and SSE through the passthrough (X-01)                                                                                             |
| `nat`                  | `nat`, `capture`, `relay-dns` | `tests/network/nat`, `packet-capture`, `relay-key-scan`, `relay-restart`, `relay-failover` | Behind NAT; relay restart within 10 s; one of two relays killed; packet capture and no engine key on the relay                                |
| `egress-443`           | `nat`, `egress-443`           | `tests/network/egress-443`                                                                 | Behind a firewall that allows only 443                                                                                                        |
| `connect-proxy`        | `nat`, `connect-proxy`        | `tests/network/connect-proxy`                                                              | Through an HTTP CONNECT proxy (tinyproxy)                                                                                                     |
| `tls-inspecting-proxy` | `nat`, `tls-inspecting-proxy` | `tests/network/tls-inspecting-proxy`                                                       | Through a TLS-inspecting proxy (mitmproxy), the browser still seeing the engine's certificate                                                 |
| `acme`                 | `acme`, `capture`             | `tests/acme/`                                                                              | The engine obtains its own certificate with ACME TLS-ALPN-01 through the relay, no DNS action (Pebble; Let's Encrypt staging is a manual run) |
| `dashboard`            | `dashboard`                   | `tests/dashboard/`                                                                         | M3: sign up with a passkey, link the engine, see it online, open it through a relay that reads its registry from the dashboard                |
| `ui`                   | `ui`                          | `tests/ui/`                                                                                | M2: the owner flows in engine-ui, from the signed bundle through the loader, under the engine CSP; also in Firefox for agents, chat, secrets  |

The `acme` scenario (M-03) adds Pebble (`.40`), an ACME test server, and `pebble-challtestsrv` (`.41`), its only resolver, which answers every name with relay-a's address. The mock engine runs with `MOCK_CERT_SOURCE=acme` and gets its certificate from Pebble with TLS-ALPN-01: Pebble's validation connects to relay-a with the engine's SNI and ALPN `acme-tls/1`, and relay-a routes it into the tunnel like a browser. Pebble issues 90-second certificates there, so the engine renews about once a minute; the tests launch Chromium with a fresh NSS database holding only Pebble's root, fetched from its management API (new every start). Pebble's own HTTPS listeners use its fixed test "minica", which init publishes as `/pki/pebble-minica.pem`. The whole flow and the Let's Encrypt staging runbook are in [spike/acme-tls-alpn-01.md](spike/acme-tls-alpn-01.md).

The failover tests take a relay down two ways: `kill` (the process is gone, its address refuses connections) and `blackhole` (the relay is paused and its address is taken off the network, so nothing answers at all). `docker pause` alone is not a blackhole: the frozen relay's kernel still accepts TCP, the browser's connection then stalls in TLS, and Chromium gives up after 30 s without trying the other relay. Browsers cannot be changed, so such a relay has to leave DNS ([I-07](plan/tasks/I-07-health-checked-relay-dns.md)): in production the engine wildcard is a health-checked Cloudflare load balancer (`infra/cloudflare`); in the `nat` scenario `relay-dns` (`compose.relay-dns.yaml`, `e2e/src/relay-dns/`) stands in for it. It asks each relay's `/healthz` on its own hostname every second with a 1 s timeout, drops a relay after 2 failures in a row and brings it back after 2 passes, never lists fewer than one relay (with none healthy it lists them all), logs a `relay_dns.*` alert on every change, and writes the `engine.test` and `order.ptbk.test` zones CoreDNS serves. The hung-relay test pauses relay-a and requires a fresh browser to load the engine through relay-b within 15 s of the hang. The stand-in is test-only code and never part of the dashboard. Each test launches its own Chromium that resolves the engine through `relay-<x>-first.order.ptbk.test`, so the relay it takes down is the one the browser tries first.

### The dashboard flow

The `dashboard` scenario (X-05, `e2e/compose.dashboard.yaml`) adds the dashboard and makes it the only registry:

```sh
E2E_SCENARIO=dashboard bun run --filter @ptbk/e2e e2e                     # build, start, test, stop
E2E_SCENARIO=dashboard bun run --filter @ptbk/e2e e2e:up                  # or keep the stack running
E2E_SCENARIO=dashboard bun run --filter @ptbk/e2e e2e:run --grep offline  # and rerun some tests against it
```

- `dashboard` (`.60`, `https://app.ptbk.test`): D-01's dev container (`apps/dashboard/Dockerfile.dev`), the built SPA and Worker in workerd under the production CSP, a local D1 in a volume, the fake email and billing adapters, and a certificate from the dev CA (init issues it when `E2E_REGISTRY=dashboard`). `DASHBOARD_VARS` (a JSON object `scripts/dev-container.sh` writes into the built Worker config) sets the engine domain `engine.test`, both relays, heartbeats every 15 s with an engine offline after 2 missed ones plus 5 s, and link codes that expire after 30 s (`LINK_CODE_TTL_S`), so expiry and offline detection are tested in real time without a clock hook.
- `registry-keys` (one-shot, no network): applies the migrations and mints one registry key per relay with D-04's `scripts/mint-relay-key.ts` (`e2e/dashboard/mint-registry-keys.sh`). Each key lands in a volume only its relay mounts and becomes that relay's `RELAY_REGISTRY_TOKEN` as it starts; only its hash reaches D1, and no log shows it.
- `relay-a`/`relay-b` use the HTTP registry (`RELAY_REGISTRY_KIND=http`, `https://app.ptbk.test`); init writes no static registry file in this scenario, and `tests/dashboard/link-engine.spec.ts` checks that none is mounted or loaded.
- `mock-engine` is in the `on-demand` profile: `up` only creates its container (`docker compose up --no-start`), and tests start one-off copies of it with the compose fixture's `run` and a link code they read from the page (`PTBK_LINK_CODE`), the stack's engine key (`key: 'stack'`, the identity in `/pki/engine.json`) or a fresh one. It registers, takes its relays from the registration and sends heartbeats. `engine-probe` is in the same profile, since nothing is routable before linking.

The specs (`e2e/src/dashboard.ts` holds their fixtures: a CDP virtual authenticator, the sign-up, billing, link-code and outbox steps, and `mockEngines.start`, `register` and `startUnlinked`): `onboarding` (X-07: Journey 1 of [onboarding.md](design/onboarding.md) on a fresh engine with `MOCK_PASSKEYS=none` and no dev login, from the plan step and the trial through the installer tab's code, `connect` run inside the engine, every state of the link checklist with the terminal's fingerprint, the setup link from `setup-link`'s stdout, the owner passkey on `/setup`, ready, "Open engine" signed in, exactly one "online" email, the reused setup link refused, `owner --reset` back to "Owner not set up", and no link code or setup secret in the engine's log stream; the onboarding targets are measured into the report as `timing` annotations and `onboarding-timings.json`, not enforced, and an expired code shows the expired state and the engine's refusal line), `link-engine` (the relays read no static registry; before linking the engine's hostname does not connect; then sign-up through the dev outbox, the fake Checkout, the link code, the engine online within 60 s under the hostname its key derives, "Reachable through 2 relays" once both relays report its tunnel (R-07), "Open" loading the engine through a relay with the engine's own certificate, sign-out and passkey sign-in), `link-codes` (a used and an expired code are refused at registration), `no-engine-requests` (no dashboard screen requests an engine hostname) and `offline` (a stopped engine turns offline after the threshold).

The stack is meant for Playwright inside its network; the [local stack](#local-stack) reuses `compose.dashboard.yaml` for a stack you click through from the host.

The `monitoring` scenario (I-04, `compose.dashboard.yaml` plus the test-only `e2e/compose.monitoring.yaml`) runs the dashboard's monitoring job against both relays. A one-shot `metrics-tokens` service makes one metrics token per relay at start (`e2e/dashboard/mint-metrics-tokens.ts`): each relay reads its own as `RELAY_METRICS_TOKEN_FILE`, and the dashboard gets them all with `MONITORING` through `DASHBOARD_VARS_FILE`, and trusts the dev CA for its scrapes (`NODE_EXTRA_CA_CERTS`). Nothing fires the Cron Trigger on its own: `tests/monitoring/relay-alert.spec.ts` fires it through the dev server's trigger endpoint (`/cdn-cgi/local/scheduled`), stops relay-a, expects one `relay-unreachable` alert in the ops outbox after the second failed check, starts relay-a and expects the alert resolved. The dev overlay and `compose.dashboard.yaml` leave `MONITORING` unset, so a trigger there runs no job ([runbook](runbooks/observability.md)).

```sh
E2E_SCENARIO=monitoring bun run --filter @ptbk/e2e e2e
```

### The engine-ui flows

The `ui` scenario (X-04, `e2e/compose.ui.yaml`) runs engine-ui as an owner uses it: the bundle packed from the checkout (`ui-bundle` stage), signed by init, installed and served by the mock engine's loader under `ENGINE_UI_CSP`, every byte through the relays. One spec per flow in `e2e/tests/ui/` (loader, agents, create agent, book, chat, security, secrets, audit, capabilities, faults, accessibility, home, runs, files, triggers, integrations, capability gating), plus `guard.spec.ts`, which proves the page guard catches what it promises.

```sh
E2E_SCENARIO=ui bun run --filter @ptbk/e2e e2e                                # build, start, every flow, stop
E2E_SCENARIO=ui bun run --filter @ptbk/e2e e2e:up                             # or keep the stack running
E2E_SCENARIO=ui bun run --filter @ptbk/e2e e2e:run tests/ui/chat.spec.ts      # one flow against it
E2E_SCENARIO=ui bun run --filter @ptbk/e2e e2e:run --project chromium --grep hostile
E2E_SCENARIO=ui bun run --filter @ptbk/e2e e2e:down
```

- Specs reach the engine only through the browser and an `EngineTarget` (`e2e/src/engine-target.ts`): its hostname, `session(subject)` and optional controls (reset, faults, simulation pause and advance, scripted runs, inbound email, bundle tampering, last heartbeat). `e2e/src/mock-engine-target.ts` is the only file that knows the mock's `/__mock/*` control listener; a flow whose control the target lacks skips with the reason, so the same specs can run against the real engine (E-03).
- Before each test the engine is reset to `small-team`, seed 1, every capability, no faults and engine time paused; time-dependent flows advance it explicitly and never sleep. Sessions come from the target (C-05's mock target for the owner and permission sets) and are set as the gateway's cookie.
- The page guard (`e2e/src/ui-fixtures.ts`, `ui-guard.ts`) fails every test, in any page of its context, on a `securitypolicyviolation`, a console message about the Content Security Policy or Trusted Types, an uncaught page error, a request to any origin but the engine's, or a native dialog.
- Secrets and integrations record every text-like response (`e2e/src/response-recorder.ts`) and check that a canary generated at run time never comes back in the page, a response, browser storage or the console; each check has a positive control that the recorder saw traffic.
- Chromium is the gate (Trusted Types). The agents, chat and secrets flows also run in Firefox, each test in a fresh profile whose certificate database is a copy of the one the entrypoint fills with the dev CA, so nothing is trusted system-wide.

Extra overlays (`E2E_OVERLAYS`, comma-separated) are layered after the scenario's:

```sh
E2E_OVERLAYS=debug bun run --filter @ptbk/e2e e2e:up
```

### Debugging from the host

The `debug` overlay publishes relay-a (through `relay-a-net`, which owns its address) on `127.0.0.1:8443` (`E2E_DEBUG_PORT` to change it). Copy the dev CA out of the stack and point a client at that port:

```sh
docker compose -p ptbk-e2e-<directory> -f e2e/compose.yaml cp relay-a:/pki/ca-cert.pem /tmp/ptbk-e2e-ca.pem
docker compose -p ptbk-e2e-<directory> -f e2e/compose.yaml exec relay-a cat /pki/engine.json   # the engine hostname
curl --cacert /tmp/ptbk-e2e-ca.pem --connect-to ::127.0.0.1:8443 https://<engineId>.engine.test/__spike/whoami
chromium --user-data-dir="$(mktemp -d)" \
  --host-resolver-rules="MAP *.engine.test 127.0.0.1:8443, MAP relay-a.ptbk.test 127.0.0.1:8443" \
  https://<engineId>.engine.test/
```

Chromium on Linux trusts the CA once it is in your NSS database (`certutil -A -d sql:$HOME/.pki/nssdb -n ptbk-e2e -t C,, -i /tmp/ptbk-e2e-ca.pem`; remove it with `certutil -D -d sql:$HOME/.pki/nssdb -n ptbk-e2e`); on macOS, add it to the login keychain only for the session and delete it afterwards. The CA is name-constrained to `engine.test` and `ptbk.test`, so it cannot vouch for any other site.

## Local stack

The whole product on your machine (X-06): the dashboard, both relays and the mock engine, from the same images and service definitions as the e2e `dashboard` scenario plus `e2e/compose.dev.yaml`. You sign up with a real passkey, link the mock engine, see it online, open it through relay-a and use the engine UI, with no cloud account and no token.

### Prerequisites

- macOS with OrbStack or Docker Desktop, or Linux with Docker Engine 25+ (Compose 2.24+). Windows is not supported for now.
- Bun and Node 24, as above; `bun install` done.
- Free on 127.0.0.1: ports 443 (relay-a), 8444 (dashboard) and 1053 (the resolver for the host). With `--no-system`, 8443 instead of 443.
- Linux only: `certutil` (`libnss3-tools` on Debian and Ubuntu) and `systemd-resolved`.

### First run

```sh
bun run dev:stack up     # builds, creates the dev CA in .dev/pki/, starts everything, prints the URLs
bun run dev:trust        # once per machine: trust the dev CA and resolve the test domains (one sudo prompt)
```

Then open `https://app.ptbk.test:8444/`, sign up (the link is on `https://app.ptbk.test:8444/__dev/mailbox`), subscribe through the fake Checkout under Billing, choose "New engine" on the Engines page to get a link code and paste the command the page shows:

```sh
bun run dev:link <code>  # registers the stack's mock engine with that code and starts it
```

The engine turns online after its first heartbeat (the mock engine sends one every 15 s; the list refreshes every minute, or reload). The dashboard keeps its production timing (an engine is offline after 3 missed 60 s heartbeats plus 15 s), so an engine on the production 60 s cadence, such as the real one, stays online without a dev setting; stopping the engine shows it offline after about 3 minutes. "Open" goes to `https://<engineId>.engine.test/` through relay-a; sign in there by picking a member (the mock engine's dev login, `MOCK_DEV_LOGIN`), with the `small-team` data seeded. That data includes the owner, so `dev:link` prints no setup link and the page's "Open the setup link your terminal shows" step completes on its own; a real install prints the link, and the `onboarding` e2e scenario covers that path. The engine UI runs under the engine's own CSP with Trusted Types, as everywhere.

| Command                               | What it does                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `bun run dev:stack up [--no-system]`  | Builds, creates or reuses the dev CA, starts the stack (project `ptbk-dev`), starts the engine if it is linked  |
| `bun run dev:stack down`              | Stops it; the account, passkeys, linked engine and engine data stay in the project's volumes                    |
| `bun run dev:stack reset`             | Stops it and drops every volume: a new dashboard database and a new engine key. The dev CA stays                |
| `bun run dev:stack logs [service...]` | Service logs with timestamps                                                                                    |
| `bun run dev:link <code>`             | Registers the stack's engine with a link code from the dashboard and (re)starts it                              |
| `bun run dev:trust [--dry-run]`       | Trusts the dev CA and adds the resolver entries; prints each command before it runs it, `--dry-run` only prints |
| `bun run dev:untrust [--dry-run]`     | Removes both again and checks that nothing is left; `--check` only checks                                       |

The fake billing state is in memory, so after `down` and `up` the account is unsubscribed again: repeat the Checkout before linking another engine. Nothing else is lost.

What the stack publishes, all on 127.0.0.1 and nothing beyond (`dev:stack up` refuses a merged config that would): relay-a on 443, the dashboard on 8444, and a CoreDNS on 1053 that answers 127.0.0.1 for `app.ptbk.test` and every `*.engine.test` name. The mock engine's control listener is not published. The dashboard's origin is `https://app.ptbk.test:8444` inside the stack too, so emailed links, the WebAuthn origin and the relays' registry URL are one and the same. The stack network is `10.89.241.0/24`, apart from e2e's `10.89.231.0/24` and `10.89.232.0/24`, so the dev stack and an e2e run share a Docker host (X-08): the compose files take the network's first three octets from `PTBK_STACK_NET` (e2e's by default, which `e2e` always uses), `dev:stack` sets it, and `dev:stack up` renders `e2e/coredns/` onto those addresses into `.dev/coredns/` for the stack's own resolver. Project names, volumes, images and container names differ by project already, and e2e publishes no host port. A dev stack created before X-08 is still on e2e's subnet: `up` says so, and `bun run dev:stack down` then `up` moves it, with the account, passkeys and linked engine kept. Trust and the host resolver are unchanged.

### The dev CA and trusting it

`dev:stack up` creates the CA once, with the mock engine's own `dev-ca` command run as you in a one-off container, in `.dev/pki/dev-ca/` (git-ignored, key 0600, kept out of every image's build context). It is name-constrained (critical) to `engine.test` and `ptbk.test`, and excludes every IP address, so even trusted it cannot vouch for any real site; the stack's `init` reuses it for the relays', the release store's and the dashboard's certificates, and the engine issues its own leaf from it. It is replaced only when it nears expiry (after a year) or its domains change; `up` then says to run `dev:trust` again.

`dev:trust` checks those name constraints before it trusts anything, then:

- macOS: `security add-trusted-cert -r trustRoot -k ~/Library/Keychains/login.keychain-db .dev/pki/dev-ca/ca-cert.pem` (macOS asks for your password or Touch ID), and one `sudo sh -c '…'` that writes `/etc/resolver/ptbk.test` and `/etc/resolver/engine.test` (`nameserver 127.0.0.1`, `port 1053`). Only those two domains, never all of `.test`.
- Linux: `certutil -A -d sql:$HOME/.pki/nssdb -n ptbk-dev-ca -t C,,` (Chrome and Chromium read that database), and one `sudo sh -c '…'` that writes `/etc/systemd/resolved.conf.d/ptbk-dev.conf` (`DNS=127.0.0.1:1053`, `Domains=~ptbk.test ~engine.test`) and restarts `systemd-resolved`.

`dev:untrust` deletes every certificate named "Promptbook mock engine dev CA" from the login keychain (with its trust settings) or the `ptbk-dev-ca` entry from NSS, removes the resolver files it wrote (a file with other content is reported, never removed), and fails unless nothing is left. Run `bun run dev:trust --dry-run` first to see exactly what it would do.

### Without changing the machine: `--no-system`

`bun run dev:stack up --no-system` trusts nothing and resolves nothing on the host. relay-a moves to 127.0.0.1:8443, and the command prints a Chrome launch line: its own profile in `.dev/chromium`, `--host-resolver-rules` mapping `app.ptbk.test` to 127.0.0.1:8444, `*.engine.test` to 127.0.0.1:8443 and every other name to nothing, and `--ignore-certificate-errors`. A browser profile cannot hold its own trust anchor on macOS, so that profile ignores certificate errors instead; the resolver rules keep it from reaching anything but the stack. Chrome allows WebAuthn under that flag (the smoke test below shows it with a virtual authenticator), so it is also the fallback when 443 cannot be bound.

The automated smoke test drives exactly that path from the host, against a fresh stack:

```sh
bun run dev:stack reset && bun run dev:stack up --no-system
bunx playwright install chromium                          # once, if Playwright's Chromium is missing on the host
bun run --filter @ptbk/e2e dev:smoke                      # E2E_DEV_BROWSER_CHANNEL=chrome uses Google Chrome
```

`e2e/tests/dev-stack/click-through.spec.ts` signs up with a virtual authenticator through a link on `/__dev/mailbox`, completes the fake Checkout, runs the install command the page shows (`bun run dev:link <code>`), waits for the engine to be online, opens it (the engine's own certificate from the dev CA, the engine CSP with Trusted Types), signs in with the dev login and chats with an agent; then it signs out, runs `dev:stack down` and `up --no-system`, signs back in with the same passkey and sees the same engine online. No CSP violation may occur anywhere.

### Troubleshooting

- **`up` fails to bind 127.0.0.1:443.** OrbStack binds it as is; Docker Desktop needs its privileged port helper (it asks for the admin password once). Another local server on 443 must stop. Otherwise use `--no-system`.
- **The browser cannot find `app.ptbk.test`.** `dig @127.0.0.1 -p 1053 app.ptbk.test` must answer 127.0.0.1 while the stack runs; `scutil --dns` (macOS) or `resolvectl status` (Linux) must list the two domains. Chrome's "Use secure DNS" with a fixed provider bypasses the system resolver: set it to the OS default.
- **A certificate error, or passkeys refused.** WebAuthn needs a trusted certificate: run `bun run dev:trust` and restart the browser; check that `bun run dev:trust --dry-run` has nothing left to do. A CA replaced after a year has to be trusted again.
- **`dev:link` says the engine was already linked.** The engine keeps its registration across `down` and `up`; the code was not used. `bun run dev:stack reset` starts over with a new engine.
- **The engine stays offline.** `bun run dev:stack logs mock-engine relay-a dashboard`. Leaf certificates and relay registry keys last 7 days and are renewed on every `up`, so a stack that ran for a week needs `down` and `up`.

## Parallel work

Each task runs in its own git worktree, so several agents (or people) can build, test and commit at the same time:

```sh
git worktree add ../app-r-01 -b feat/r-01-sni-parser origin/main
cd ../app-r-01 && bun install
```

Remove it after the merge with `git worktree remove ../app-r-01`. The full procedure is in [AGENTS.md](../AGENTS.md#working-on-a-task).

## Adding a module

1. Create `apps/<name>` or `packages/<name>` with `package.json` (`"name": "@ptbk/<name>"`, `"private": true`, `typecheck` and `test` scripts; packages also get `"exports": { ".": "./src/index.ts" }`), `tsconfig.json` extending `../../tsconfig.base.json`, `src/` and a `README.md`.
2. Add its scope to `commitlint.config.js` and to [conventions.md](conventions.md).
3. Describe it in [architecture.md](architecture.md), and record why in an ADR if it changes the architecture.

Workspace packages are referenced as `"@ptbk/protocol": "workspace:*"`, so they always resolve locally, never from npm.

## CI

GitHub Actions in `.github/workflows`:

- `ci.yml`: install, then `bun run check` as one step (generate, lint, format, types, tests, plan), so whatever runs locally runs in CI; `engine-ui-csp`, which runs the built engine UI in Chromium under the engine's CSP (`bun run --filter @ptbk/engine-ui test:csp`); `e2e`, the browser suite in Docker Compose ([End to end](#end-to-end); images are built from scratch every run, and `e2e/test-results/` is uploaded on failure); and a zizmor audit of the workflows themselves.
- `commits.yml`: commitlint on every commit in a PR and on the PR title.
- `ui-release.yml`: builds, signs and publishes the engine UI bundle on a `ui-v*` tag push (see [UI releases](#ui-releases)).
- `deploy-dashboard.yml`, `rollback-dashboard.yml` and `release-relay.yml`: the dashboard and relay deploys behind the `staging` and `production` environments, and the signed relay image; pull requests only build and dry-run them ([runbooks/deploy.md](runbooks/deploy.md)). `ci.yml`'s `relay-deploy` job runs `infra/relay/test/deploy-test.sh`: the relay hosts' deploy script, signature refusals and a rolling deploy with a broken image, against two hosts in containers.

`ci.yml` runs every job on main after each merge, one run per commit and none cancelled, and every Monday on a schedule. The exception is a push to main whose changes since its `before` commit are all documentation (Markdown or `docs/`): it runs only `check`'s Prettier, plan and engine guide checks. A force-push or a push without `before` runs everything. A green run on such a push says nothing about the code; that commit's own run does. A pull request runs only what its files reach: the `changes` job (`scripts/ci-scope.ts`) maps each changed file to its workspace, adds every workspace that depends on it (including the undeclared ones: conformance runs the mock engine, e2e builds most apps), and attributes a `bun.lock` change to the workspaces that install a changed entry. `check` then runs the root `check` script with tests only for those workspaces, and each heavy job runs only if it exercises one of them (or `infra/` for the infra jobs). Markdown, `docs/`, `.github/` other than `ci.yml`, `.vscode/` and `.husky/` reach no workspace: `check` runs only Prettier and the plan and engine guide checks. Anything the script cannot attribute (a root config file, `scripts/`, `ci.yml` itself, a root dev tool in `bun.lock`) runs everything. `ci-passed` is the one status to require: skipped jobs count as passed, failed or cancelled ones fail it. A pull request's superseded run is cancelled; main's never is.

Workflow rules: actions pinned to full commit SHAs, `permissions: contents: read` by default, `persist-credentials: false`, no caches, no `pull_request_target`, untrusted values (PR title, branch names) passed through `env`, never interpolated into scripts.

## UI releases

The engine UI ships as a signed bundle ([ADR 0003](adr/0003-ui-as-signed-bundle.md), task X-03). Pushing a tag is the only trigger, because C-06 pins the Sigstore build trigger to `push`: a manually dispatched run could never verify.

| Tag                    | What runs                                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ui-v<version>`        | `<version>` must equal `apps/engine-ui/package.json`. Build, sign, staging signature, `release:verify`, upload to staging R2 |
| `ui-v0.0.0-dryrun.<n>` | Dry run, `<n>` a positive integer: everything above except the upload. `0.0.0-dryrun.<n>` sorts below every real version     |

The workflow has three jobs:

1. **build**: checks the tag, runs `check` and `test:csp`, then `pack` and `verify-reproducible` (two more builds in fresh worktrees with another TZ, locale, umask and path, compared byte for byte with the first).
2. **sign** (the only job with `id-token: write`): signs the archive keylessly (`engine-ui.tar.zst.sigstore.json`), writes the C-06 `ReleaseEntry` payload bytes once (`release-payload.json`) and attests them with `sigstore.attest()`, which logs a DSSE entry in Rekor with an RFC 3161 timestamp (`release-provenance.sigstore.json`).
3. **publish** (GitHub environment `release`, a second maintainer approves; see [the deploy runbook](runbooks/deploy.md)): signs the payload's DSSE PAE with the staging release key, writes the `SignedRelease` (`release.json`), runs `release:verify` against the staging trust policy, and, unless it is a dry run, uploads `ui/<version>/engine-ui.tar.zst`, `ui/<version>/manifest.json`, `ui/<version>/engine-ui.tar.zst.sigstore.json`, `ui/<version>/trusted_root.json` (the pinned Sigstore trusted root it verifies against, for offline verifiers and mirrors) and `release-log/ui-<version>.json`. A version that exists is never overwritten: any existing key stops the upload, and every PUT carries `If-None-Match: *`.

What the `release` environment needs (repository settings, set by a maintainer):

| Name                              | Kind     | Value                                                                                    |
| --------------------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `UI_STAGING_RELEASE_KEY`          | secret   | base64url of the 32-byte Ed25519 seed whose public key is in `trust-policy.staging.json` |
| `UI_STAGING_R2_ACCESS_KEY_ID`     | secret   | R2 API token access key ID, write access to the staging bucket only                      |
| `UI_STAGING_R2_SECRET_ACCESS_KEY` | secret   | its secret                                                                               |
| `UI_STAGING_R2_ENDPOINT`          | variable | `https://<account id>.r2.cloudflarestorage.com`                                          |
| `UI_STAGING_R2_BUCKET`            | variable | the staging bucket name                                                                  |

The environment allows deployments only from tags matching `ui-v*`.

### Cutting a UI release

```sh
# bump apps/engine-ui/package.json "version", merge it, then on that commit of main:
git tag ui-v0.2.0 && git push origin ui-v0.2.0
# a dry run of the whole pipeline without the upload:
git tag ui-v0.0.0-dryrun.4 && git push origin ui-v0.0.0-dryrun.4
```

Approve the `publish` job when it waits for the `release` environment (another maintainer than the one who pushed the tag). A dry run's `release.json` is a workflow artifact (`ui-release`).

### Verifying a release

Download `ui/<version>/engine-ui.tar.zst` and `ui/<version>/manifest.json`, and `release-log/ui-<version>.json` saved as `release.json`, into one directory (or download the `ui-bundle` and `ui-release` artifacts of a run), then:

```sh
bun run --filter @ptbk/engine-ui release:verify <dir> [--policy <trust policy>] [--trusted-root <file>]
```

It runs C-06's `verifyRelease` with the real Sigstore verifier (built on `@sigstore/verify`, exact identity, the pinned `packages/release-tools/src/trusted_root.json`, no network): the release-key signature, the provenance with its Rekor entry and trusted time, then the archive hash and every file against the manifest. The update delay is the installing engine's concern and is not checked. Put a signed revocation list next to the files as `revocations.json` to check it too; without one, the output says so.

### Locally

| Command                                                         | What it does                                                                                              |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `bun run --filter @ptbk/engine-ui pack [--tag <tag>]`           | `release/engine-ui.tar.zst` and `release/manifest.json` from a clean tree (`--allow-dirty` to experiment) |
| `bun run --filter @ptbk/engine-ui verify-reproducible`          | Two fresh builds of `HEAD`, compared byte for byte; names the first differing file                        |
| `bun run --filter @ptbk/engine-ui release:keygen <file>`        | A staging or test release key: seed to `<file>` (0600), public key printed                                |
| `bun run --filter @ptbk/engine-ui release:refresh-trusted-root` | Refreshes the pinned Sigstore trusted root through TUF; the change lands in its own reviewed PR           |

Reproducibility depends on the exact Node version (`.nvmrc`, which also fixes the zstd library), `bun.lock`, `SOURCE_DATE_EPOCH` (the commit time) and a deterministic tar (byte-sorted entries, fixed owner, modes and mtime).

## Staging

Staging is brought up by hand from a laptop, without CI: [staging-runbook.md](staging-runbook.md). `node scripts/staging/generate-secrets.ts` prints every secret staging generates itself, and `node scripts/staging/fill-placeholders.ts` writes the values from a local, git-ignored `staging.env` into the staging configs. Their tests run with `bun run test:scripts`, which `bun run test` includes.
