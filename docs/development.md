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
| `dns`                  | CoreDNS (`e2e/coredns/Corefile`): `relay-a/b.ptbk.test`, `releases.ptbk.test`, and both relay addresses for every `*.engine.test` name; everything else is refused                                                                                                                                                                                                                                                                                      |
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

Each checkout gets its own compose project (`ptbk-e2e-<directory>`, or `E2E_PROJECT`), so worktrees never drive each other's containers. The subnet is fixed, so only one stack runs per Docker host at a time: a second `e2e:up` fails on the overlapping network instead of taking over the first.

### Scenarios

A scenario is one run of the stack: `compose.yaml` plus overlays (`e2e/compose.<name>.yaml`, layered in order) and the specs that need exactly that topology (`e2e/src/scenarios.ts`). The network scenarios (X-02) put the mock engine on `engine-lan` (`10.89.232.0/24`), an internal network with no address on the host's bridge, so nothing can route into it; its only way out is `gateway` (`.2` on the LAN, `10.89.231.20` outside), whose rules and their reasons are in `e2e/gateway/gateway.sh`. The engine runs in the network namespace of `engine-net`, which sets the route and listens on 443 and 8080 so "nothing reaches the engine" is tested against open ports. Only `gateway` and `engine-net` get `NET_ADMIN`, and relay-a's capture only `NET_RAW` (as a file capability of tcpdump, run as nobody); the playwright service gets nothing new.

| Scenario               | Overlays                      | Specs                                                                                      | Spike criterion (spec, Build plan)                                                                                                            |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `spike`                | none                          | `tests/spike/`, `tests/harness/`                                                           | WebSockets and SSE through the passthrough (X-01)                                                                                             |
| `nat`                  | `nat`, `capture`              | `tests/network/nat`, `packet-capture`, `relay-key-scan`, `relay-restart`, `relay-failover` | Behind NAT; relay restart within 10 s; one of two relays killed; packet capture and no engine key on the relay                                |
| `egress-443`           | `nat`, `egress-443`           | `tests/network/egress-443`                                                                 | Behind a firewall that allows only 443                                                                                                        |
| `connect-proxy`        | `nat`, `connect-proxy`        | `tests/network/connect-proxy`                                                              | Through an HTTP CONNECT proxy (tinyproxy)                                                                                                     |
| `tls-inspecting-proxy` | `nat`, `tls-inspecting-proxy` | `tests/network/tls-inspecting-proxy`                                                       | Through a TLS-inspecting proxy (mitmproxy), the browser still seeing the engine's certificate                                                 |
| `acme`                 | `acme`, `capture`             | `tests/acme/`                                                                              | The engine obtains its own certificate with ACME TLS-ALPN-01 through the relay, no DNS action (Pebble; Let's Encrypt staging is a manual run) |

The `acme` scenario (M-03) adds Pebble (`.40`), an ACME test server, and `pebble-challtestsrv` (`.41`), its only resolver, which answers every name with relay-a's address. The mock engine runs with `MOCK_CERT_SOURCE=acme` and gets its certificate from Pebble with TLS-ALPN-01: Pebble's validation connects to relay-a with the engine's SNI and ALPN `acme-tls/1`, and relay-a routes it into the tunnel like a browser. Pebble issues 90-second certificates there, so the engine renews about once a minute; the tests launch Chromium with a fresh NSS database holding only Pebble's root, fetched from its management API (new every start). Pebble's own HTTPS listeners use its fixed test "minica", which init publishes as `/pki/pebble-minica.pem`. The whole flow and the Let's Encrypt staging runbook are in [spike/acme-tls-alpn-01.md](spike/acme-tls-alpn-01.md).

The failover tests take a relay down two ways: `kill` (the process is gone, its address refuses connections) and `blackhole` (the relay is paused and its address is taken off the network, so nothing answers at all). `docker pause` alone is not a blackhole: the frozen relay's kernel still accepts TCP, the browser's connection then stalls in TLS, and Chromium gives up after 30 s without trying the other relay. That is a known limit, not a test gap: a hung relay that still accepts TCP is not failed over by browsers, and `relay-failover.spec.ts` pins it (the browser does not reach the engine within 15 s) until [I-07](plan/tasks/I-07-health-checked-relay-dns.md) takes such a relay out of DNS; that test then has to change. Each test launches its own Chromium that resolves the engine through `relay-<x>-first.order.ptbk.test`, so the relay it takes down is the one the browser tries first.

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
3. **publish** (GitHub environment `staging`, reviewer required): signs the payload's DSSE PAE with the staging release key, writes the `SignedRelease` (`release.json`), runs `release:verify` against the staging trust policy, and, unless it is a dry run, uploads `ui/<version>/engine-ui.tar.zst`, `ui/<version>/manifest.json`, `ui/<version>/engine-ui.tar.zst.sigstore.json` and `release-log/ui-<version>.json`. A version that exists is never overwritten: any existing key stops the upload, and every PUT carries `If-None-Match: *`.

What the `staging` environment needs (repository settings, set by a maintainer):

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

Approve the `publish` job when it waits for the `staging` environment. A dry run's `release.json` is a workflow artifact (`ui-release`).

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
