# X-06. Local dev stack for humans: the whole product on one machine

- **Lane:** X · **Module:** `e2e/` (plus small touches in `apps/dashboard` and `apps/mock-engine`) · **Milestone:** M3
- **Depends on:** X-05
- **Status:** in progress (feat/x-06-dev-stack)
- **Spec:** Pairing and identity (First setup); What our platform can and cannot do; One address for users; ADRs: [0004](../../adr/0004-mock-engine-and-conformance.md)

## Goal

One command brings up the dashboard, both relays and the mock engine on a developer's machine, and a person can click through the whole product in their own browser: sign up with a real passkey, link the mock engine, see it online, open it through the relay and use the engine UI, with no cloud account and no token.

## Context

The plan's current priority is local-first ([README](../README.md#current-priority-local-first)): everything that needs no credential is built and testable before the cloud accounts exist. X-01 and X-05 run the same components in Docker Compose, but for tests: every run starts from fresh volumes and freshly generated keys, the engine is started by the test, and nothing is reachable from the host except an optional debug port. A person needs the opposite: a stack that keeps its state across restarts, a dev CA the browser trusts (WebAuthn refuses any page with a certificate error), host names that resolve on the host, and a way to link the engine and read the fake outbox by hand.

The host-side parts (persistent CA, trust script, resolver, mailbox page, and a `dev` profile with only the relays and the mock engine) do not need X-05 and may land first as a separate PR with `Refs: X-06`; the dashboard part reuses X-05's `compose.dashboard.yaml` once it exists.

## Scope

- `bun run dev:stack` with `up`, `down`, `reset` (drops the volumes) and `logs`, implemented in `e2e/src/cli.ts` next to the existing commands, as compose project `ptbk-dev` so it never collides with the test project. It combines `compose.yaml`, `compose.dashboard.yaml` (X-05) and a new `compose.dev.yaml` that:
  - uses named volumes, so the dashboard's D1, the engine's key and data, and the relays' state survive `down` and `up`;
  - leaves out Playwright and the test probes;
  - publishes on loopback only: relay-a on `127.0.0.1:443`, the dashboard on `127.0.0.1:8444`, CoreDNS on `127.0.0.1:1053` (answering `127.0.0.1` for `app.ptbk.test` and `*.engine.test`; 5353 is mDNS on macOS). The mock engine's control listener is not published;
  - runs the mock engine with `MOCK_DEV_LOGIN` enabled and the `small-team` scenario, so the engine UI can be signed into without the engine's own passkey setup.
- A persistent, name-constrained dev CA in `.dev/pki/` (git-ignored), created on first use and reused by the stack's `init` instead of a fresh CA per run. The e2e suite keeps generating its own.
- `bun run dev:trust` and `bun run dev:untrust`: add or remove the dev CA (macOS login keychain; NSS database on Linux) and the resolver entries for `ptbk.test` and `engine.test` only, never all of `.test` (`/etc/resolver/` on macOS, `systemd-resolved` on Linux), with one `sudo` prompt. `dev:stack up --no-system` changes nothing on the host and prints a Chromium launch line with `--host-resolver-rules` and a separate profile instead.
- `bun run dev:link <code>`: starts or restarts the stack's mock engine with `PTBK_LINK_CODE`, so the install command the dashboard shows in dev (D-03) is what a person pastes.
- Dashboard mailbox, reusing D-02's existing `GET /api/__dev/emails` (mounted only with the fake email adapter): `to` becomes optional and, when absent, lists every recorded message. An SPA page `/__dev/mailbox` shows the outbox with clickable links, rendered under the normal dashboard CSP and routed only when the email adapter is `fake` (D-01's config already allows that only in dev). No new server-rendered HTML route.
- Mock engine: a `register` script in `apps/mock-engine/package.json` (the README already documents the command).
- `docs/development.md`: a "Local stack" section: prerequisites, first run, trusting and untrusting, linking, resetting, troubleshooting.

## Out of scope

- The e2e tests themselves (X-05, X-04): this task must not change what they run.
- Real Stripe, email or DNS: the fake adapters stay; wiring real services is in [apply.md](../apply.md).
- Windows hosts (document as unsupported for now).

## Design notes

- Reuse, don't fork: the dev overlay only changes ports, volumes, profiles and environment. A service definition that differs between e2e and dev beyond that is a sign X-05's overlay contains something test-only; fix it there.
- Nothing may listen beyond loopback; the dev login and the control listener must never be reachable from the network.
- The CA's name constraints limit it to `ptbk.test`, `engine.test` and the relays' test names, so trusting it on a personal machine cannot be abused for real domains.
- Passkeys cannot be seeded, so the account is created live; the engine side comes seeded from the mock engine's scenario.

## Acceptance criteria

- [ ] Automated smoke test over the `--no-system` path: Playwright with a WebAuthn virtual authenticator signs up via a link from `/__dev/mailbox`, completes the fake checkout, links the engine with `bun run dev:link <code>`, sees it online, opens it, signs in with the dev login and chats with an agent.
- [ ] Manual evidence on a fresh macOS machine with Docker Desktop or OrbStack: `bun run dev:trust`, then `bun run dev:stack up`. In real Chrome, a person signs up at `https://app.ptbk.test:8444` with a Touch ID passkey (link from `/__dev/mailbox`), completes the fake checkout, runs `bun run dev:link <code>` with the code shown, sees the engine online, clicks "Open", signs in with the dev login and chats with an agent. Recorded in the PR (screen recording or screenshots).
- [ ] `bun run dev:stack down` and `up` keep the account, the passkey and the linked engine. The fake billing state is in memory and is lost on `down`; that is accepted, and the checkout is repeated.
- [ ] `bun run dev:untrust` leaves no CA in the keychain or NSS database and no resolver entry (checked by a script).
- [ ] No published port binds to anything but `127.0.0.1` (test over the merged compose config).
- [ ] With an email adapter other than `fake`, `/api/__dev/emails` returns 404 and the SPA has no `/__dev/mailbox` route (tests).
- [ ] The e2e suite still runs unchanged and green.
- [ ] `docs/development.md` has the "Local stack" section.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Binding port 443 on the host: on macOS, unprivileged binds below 1024 work only on the wildcard address, not on `127.0.0.1`. Docker Desktop needs its privileged-port helper (admin password once); OrbStack handles it. The engine "Open" link has no port, so 443 is required. If 443 on loopback is unavailable, `dev:stack up` fails with a clear message and points to `--no-system`, whose Chromium `--host-resolver-rules` map the hostnames to another loopback port; it never falls back to binding the wildcard address.
- WebAuthn requires a secure context with a trusted certificate; without `dev:trust` (or the `--no-system` Chromium profile with the CA imported) passkeys will not work.
- Docker Desktop's DNS and the host resolver differ between versions; test both Docker Desktop and OrbStack.
