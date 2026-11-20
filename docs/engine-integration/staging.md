# Run your engine against staging

Staging is the platform's live environment: the real dashboard, a real relay, certificates from Let's Encrypt and our signed UI releases. Our mock engine runs on it end to end since 2026-11-11. This page gets your engine there, and gives you one read-only command that says what still fails.

Run the [conformance suite](testing-against-the-platform.md) first. Staging shows whether the pieces work together on the internet; the suite shows why one does not.

## What staging is

| Part             | Address                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Dashboard        | `https://app.ptbk.io`: sign up with an email and a passkey. Billing is off: every account may link up to 10 engines    |
| Engine domain    | `engines.ptbk.link`: your engine is `https://<engineId>.engines.ptbk.link/`, and every such name resolves to the relay |
| Relay            | One relay for now. The registration names it; every engine hostname resolves to its addresses                          |
| UI release store | `https://ui.ptbk.link/`, in the [release mirror layout v1](ui-loader.md#release-mirror-layout-v1)                      |
| Trust policy     | `apps/engine-ui/release/trust-policy.staging.json` in the platform checkout: profile `staging`, 5-minute delays        |
| Certificates     | Let's Encrypt production, TLS-ALPN-01 through the relay. The CAA record allows only `letsencrypt.org`                  |
| Heartbeats       | Every 60 s, to the dashboard                                                                                           |

## Prerequisites

- Your engine passes `--suite registration,heartbeat,tunnel,ui-loader` locally, including both `ui-loader.trust-policy.*` checks.
- Node 24, and a platform checkout at `$PLATFORM_DIR` with `bun install` run in it ([implementation-plan.md](implementation-plan.md#phase-0-setup-and-contracts)).
- The conformance CLI built: `(cd "$PLATFORM_DIR" && bun run --filter @ptbk/conformance build)`.
- Outbound HTTPS to `app.ptbk.io`, the relay the registration names, `ui.ptbk.link` and `acme-v02.api.letsencrypt.org`. Nothing inbound: the engine dials out.
- A browser that can create a passkey.

## Settings

A [staging build](ui-loader.md#staging-builds) of `ptbk`, installed from the block on app.ptbk.io → Engines → New engine, needs none of this: it embeds the staging policy and defaults. The settings below are for any other build.

Start the engine from your own shell, not from the release image or the installer's service: those set `NODE_ENV=production`, and production refuses the staging trust policy ([ui-loader.md](ui-loader.md#where-the-trust-policy-comes-from)). If your bundler inlines `NODE_ENV`, use a build that does not.

```sh
export NODE_ENV=development
export PTBK_DATA_DIR="$HOME/.ptbk-staging-engine"
export PTBK_ENGINE_DOMAIN=engines.ptbk.link
export PTBK_ACME_DIRECTORY_URL=https://acme-v02.api.letsencrypt.org/directory
export PTBK_UI_RELEASE_URL=https://ui.ptbk.link/
export PTBK_UI_TRUST_POLICY_FILE="$PLATFORM_DIR/apps/engine-ui/release/trust-policy.staging.json"
```

- `PTBK_UI_TRUST_POLICY_FILE` must be an absolute path. Use the file from the platform checkout as it is; never copy or edit it.
- Leave `PTBK_DASHBOARD_URL`, `PTBK_RELAYS` and `NODE_EXTRA_CA_CERTS` unset. The link URL names the dashboard, the registration names the relay, and everything on staging has a public certificate.
- The mock engine also needs `MOCK_CERT_SOURCE=acme` (it defaults to its development CA). `MOCK_UI_CHECK_INTERVAL_S=60` makes it install a UI release a minute after the delay instead of an hour.

## Step by step

1. **Sign up.** Open `https://app.ptbk.io`, sign up with your email, confirm it, and create a passkey.
2. **New engine.** Engines, New engine. Copy the link URL the page shows, `https://app.ptbk.io/link#<code>`. It works once and lasts 30 days. Treat it like a password: never commit, log or paste it into a report.
3. **Link.** In the shell with the settings above:

   ```sh
   mkdir -m 700 -p "$PTBK_DATA_DIR"
   <your engine> connect --link 'https://app.ptbk.io/link#<code>'
   ```

   It prints `https://app.ptbk.io`, then the engine ID and the fingerprint. Compare the fingerprint with the one on the page.

4. **Start.** `<your engine>` with the same settings. Keep it running.
5. **Wait.** Within about a minute: the tunnel to the relay is up, the first heartbeat arrives, and the dashboard shows the engine online, "Reachable through 1 relay". Then the engine orders its certificate through the relay; the first one takes up to a minute more.
6. **Owner.** Once the address works, the engine started in step 4 prints the setup link on its terminal and opens it in your browser ([installation.md](installation.md#the-setup-link)); create the owner's passkey there. If nothing opened, open the printed link, or run `<your engine> setup-link` on the same host for a fresh one. The setup link is printed only on the terminal; the platform never sees it.
7. **UI.** At startup the engine sees the current release in `ui/latest.json` and records when it first saw it. With the staging policy it installs 5 minutes later, at its next update check. Restart the engine after 5 minutes if its check interval is longer. `GET /api/v1/security` → `ui.lastUpdateCheck` says `delay-not-elapsed` with `eligibleAt` until then.
8. **Check.** Run the [staging check](#the-staging-check) until nothing fails.

For the mock engine, from the platform checkout:

```sh
bun run --filter @ptbk/mock-engine build
export MOCK_CERT_SOURCE=acme MOCK_UI_CHECK_INTERVAL_S=60
node apps/mock-engine/dist/main.mjs connect --link 'https://app.ptbk.io/link#<code>'
node apps/mock-engine/dist/main.mjs              # runs the engine; prints and opens the setup link once reachable
node apps/mock-engine/dist/main.mjs setup-link   # only if you need a fresh link: in a second shell, same settings
```

## The staging check

`ptbk-conformance staging` checks your engine from the outside, the way a browser and the platform see it. It only reads: DNS lookups, TLS handshakes and `GET` requests.

```sh
node "$PLATFORM_DIR/packages/conformance/dist/ptbk-conformance.js" staging \
  --engine https://<engineId>.engines.ptbk.link
```

- `--json` prints one JSON object for agents: `{ "engine", "ok", "checks": [{ "id", "status", "detail", "fix" }] }`.
- `--release-url <url>` checks against another release store (default `https://ui.ptbk.link/`); `--relay <hostname>`, repeatable, against other relays (default: the staging relay).
- The UI and engine checks need the owner's session, because the gateway serves nothing else to an anonymous visitor. Sign in on the engine, copy the `__Host-ptbk_session` cookie from the browser's developer tools, and pass it as `PTBK_CONFORMANCE_OWNER_COOKIE='__Host-ptbk_session=<value>'`. Without it those checks skip. It is a secret: keep it out of shell history, logs and reports.
- Exit code 0 only when no check failed, 1 when one did, 2 for a usage error.

It hits live staging, so it is never part of CI and never runs in the platform's tests. Run it by hand, or from your agent's loop.

| Check                            | Passes when                                                                                                                    | When it fails                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staging.dns.via-relay`          | The engine's hostname resolves only to the relay's addresses                                                                   | The engine ID is wrong, or the engine is not linked and registered (`connect --link`)                                                                                                                                                                                                                                                                 |
| `staging.tls.public-certificate` | A certificate from Let's Encrypt for exactly the engine's hostname, valid under the public roots alone                         | A reset connection: the relay has no tunnel from your engine (is it running and connected?). A certificate from your development CA: ACME is off or failed (`PTBK_ACME_DIRECTORY_URL`; the mock also needs `MOCK_CERT_SOURCE=acme`). An issuer marked `(STAGING)`: use Let's Encrypt's production directory. See [tunnel-client.md](tunnel-client.md) |
| `staging.gateway.sign-in`        | `/auth/sign-in` serves the sign-in page                                                                                        | The gateway does not serve `SIGN_IN_PATH` ([gateway.md](gateway.md))                                                                                                                                                                                                                                                                                  |
| `staging.gateway.setup`          | `/setup` is served                                                                                                             | The gateway does not serve the setup page                                                                                                                                                                                                                                                                                                             |
| `staging.gateway.anonymous`      | An anonymous `/` redirects to sign-in and an anonymous API call gets 401                                                       | Something answers before the gateway, or the gateway lets anonymous requests through                                                                                                                                                                                                                                                                  |
| `staging.headers.csp`            | The `Content-Security-Policy` is `ENGINE_UI_CSP`, byte for byte                                                                | The engine builds its own header, or reads the manifest's `csp`                                                                                                                                                                                                                                                                                       |
| `staging.engine.info`            | `GET /api/v1/engine` reports mode `tunnel`, the engine ID from the hostname and the hostname itself                            | The engine runs in another mode, or reports another identity                                                                                                                                                                                                                                                                                          |
| `staging.ui.release`             | The release store serves `ui/latest.json`, the release record and the archive of the version the engine serves, and they agree | The store is unreachable or inconsistent: tell the maintainer, it is ours                                                                                                                                                                                                                                                                             |
| `staging.ui.served`              | `index.html` and the assets it loads are byte for byte the files in that release's manifest                                    | "No verified UI release": the engine has no trust policy or has not installed one yet. Set `PTBK_UI_RELEASE_URL` and `PTBK_UI_TRUST_POLICY_FILE` as above, outside production, and wait 5 minutes. A hash mismatch: the engine serves files the release does not contain                                                                              |

Every failure and skip prints its own fix line too. When the TLS check fails, the checks that need the engine skip with "fix `staging.tls.public-certificate` first".

## Troubleshooting

| Symptom                                                                                             | Cause and fix                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The engine exits at once naming `PTBK_UI_TRUST_POLICY_FILE`, "staging"                              | It runs in production. Unset `NODE_ENV` or set `development`, or use a build that does not inline it                                                                                                                                                   |
| The browser warns about the certificate; `staging.tls.public-certificate` names your development CA | ACME is off. Set `PTBK_ACME_DIRECTORY_URL` as above (the mock: `MOCK_CERT_SOURCE=acme`) and restart                                                                                                                                                    |
| ACME validation fails                                                                               | The order started before a tunnel was ready, or `acme-tls/1` hellos do not reach your responder ([tunnel-client.md](tunnel-client.md)). Let's Encrypt rate-limits failed validations: fix the cause before you retry                                   |
| Online only after a minute, or "No relay"                                                           | Without a working tunnel the first heartbeat waits a full interval. Check the engine's log for the relay the registration named                                                                                                                        |
| `setup-link` says there is already an owner (the mock)                                              | The data directory already holds an owner's passkeys, or the mock runs with `MOCK_PASSKEYS=seeded`. Start it with a fresh data directory, or run `owner --reset`                                                                                       |
| The engine serves its plain page, "no verified UI release"                                          | No policy: `PTBK_UI_TRUST_POLICY_FILE` is unset. Or `ui.lastUpdateCheck` says why: `delay-not-elapsed` (wait until `eligibleAt`, then restart or wait for the next check), `revocations-unverifiable` or a missing release (ours: tell the maintainer) |
| `ui/latest.json` names a version the store does not have                                            | Ours. `curl https://ui.ptbk.link/ui/latest.json` and `curl -I https://ui.ptbk.link/release-log/ui-<version>.json` show it; tell the maintainer                                                                                                         |
| `connect` exits with `invalid-link-code`                                                            | The code was used, cancelled or is older than 30 days. Make a new one on Engines                                                                                                                                                                       |
| `connect` exits with `engine-limit`                                                                 | The account already has 10 engines. Revoke one on Engines                                                                                                                                                                                              |

## Never

- **Never use the staging policy in production**, and never ship a build that accepts it there. It trusts the staging release key and waits 5 minutes instead of 72 hours.
- **Never commit a key, a link URL, a setup link or a session cookie**, and never paste one into a log, an issue or a report. The staging release key is ours and never leaves the maintainers' password manager; you never need it.
- **Never edit the staging trust policy** or point your engine at a policy of your own on staging: the releases on `ui.ptbk.link` verify only under ours.
- **Never loop on fresh data directories.** Each new engine is a new hostname and a new Let's Encrypt certificate, and `ptbk.link` shares Let's Encrypt's weekly limits with everyone on staging. Keep one data directory and restart it.
- **Never run load or fuzz tests against staging.** The relay and the dashboard are shared. Use the conformance suite and the local stack for that.
