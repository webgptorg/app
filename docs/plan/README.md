# Implementation plan

How we get from an empty repo to the private half of the zero-trust interface: relay, dashboard and engine-ui, all working end to end against a mock engine, with the real engine plugged in last.

The [spec](../spec/zero-trust-spec.md) says what and why. The [ADRs](../adr/) record decisions taken since. This plan says in which order, in tasks small enough for one PR each.

## Principles

1. **Contracts first.** `protocol` and `engine-api` land before the code that uses them, so modules can be built in parallel against the same interfaces.
2. **Mock first, real engine last** ([ADR 0004](../adr/0004-mock-engine-and-conformance.md)). Everything is proven end to end against the mock engine. The conformance suite is how the real engine proves it can replace it.
3. **Riskiest first.** Milestone 1 is the spec's spike: TLS through the relay, including ACME TLS-ALPN-01, NAT, proxies and failover.
4. **One task, one PR, one module** where possible. A task that has to touch two modules says so.
5. **Every task leaves `main` green**: `bun run check` passes, and from X-01 on, the e2e suite passes too.

## Milestones

| Milestone          | Goal                                                         | Done when                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M0 Foundation**  | Repo, tooling, docs, plan                                    | Done (this commit)                                                                                                                                                        |
| **M1 Spike**       | Relay end to end with the mock engine                        | Every spike criterion in the spec (Build plan, "Spike acceptance criteria") passes as an automated e2e test                                                               |
| **M2 Engine UI**   | The private UI, running on the mock engine through the relay | The owner flows (agents, create agent, chat, security panel, secrets, audit) pass in e2e under the engine's strict CSP, loaded through the UI loader from a signed bundle |
| **M3 Dashboard**   | app.ptbk.io                                                  | Sign up with a passkey, link the mock engine, see it online, open it through the relay; the relay reads its registry from the dashboard                                   |
| **M4 Production**  | Our side runs in staging, then production                    | Two relays and the dashboard live in staging, deploys are signed and approved, monitoring without content, abuse controls, internal security review passed                |
| **M5 Real engine** | Swap the mock for the engine team's engine                   | Contracts are public, the real engine passes the conformance suite and the full e2e suite                                                                                 |

M2 and M3 can run in parallel once M1's contracts exist. E-01 (the engine integration guide) is pulled forward into M2 because the engine team needs lead time.

## Lanes

| Lane               | Module(s)                                                          | Prefix |
| ------------------ | ------------------------------------------------------------------ | ------ |
| Contracts          | `packages/protocol`, `packages/engine-api`, `packages/conformance` | C      |
| Relay              | `apps/relay`                                                       | R      |
| Mock engine        | `apps/mock-engine`                                                 | M      |
| Engine UI          | `apps/engine-ui`, `packages/ui`                                    | U      |
| Dashboard          | `apps/dashboard`                                                   | D      |
| Cross-cutting      | `e2e/`, release tooling                                            | X      |
| Infra              | `infra/`, deploy workflows                                         | I      |
| Engine integration | docs, contract publishing                                          | E      |

## Current priority: local-first

Decided 2026-10-21 (Seb): until the cloud accounts and tokens exist, build everything that needs none, so the whole product can be clicked through locally (dashboard, relay, mock engine, engine UI) with no external service.

**CI.** The repository is public, so Actions cost no minutes and every pull request runs CI again, scoped to what it changes; AGENTS.md step 9 applies as written ([development.md, CI](../development.md#ci)). Between 2026-10-21 and 2026-11-25 billing limits made local checks the gate, and work landed on main with `[skip ci]`; a full CI run on main after the switch covers it.

Then, in this order, with the lanes in parallel:

1. **Dashboard chain to the local click-through:** D-03 → D-04 and D-05 → D-06 → X-05 → [X-06](tasks/X-06-local-dev-stack.md). X-06's host-side parts can start next to D-03.
2. **Engine UI breadth:** U-04, U-06 to U-12 and M-07, then X-04.
3. **Infra code that needs no credential:** R-06, R-05, M-03, and the code parts of I-01, I-03, I-04, I-05 and I-07, verified in CI (offline `tofu test`, a local VM, compose e2e).
4. **Apply steps** that need accounts, tokens, domains or hardware keys wait for a human. Each brief lists them under "Apply (needs credentials)", and [apply.md](apply.md) collects them, with every credential, in the order to run them.

A task whose code is merged and whose only remaining work is an Apply step is `done`, so it does not block its dependants; the Apply step is tracked in [apply.md](apply.md).

## Tasks

Each brief in [tasks/](tasks/) carries its own **Depends on** and **Status** (`todo`, `in progress (<branch>)`, `done (#<PR>)`), so parallel PRs never edit the same line. What a task unblocks is derived from the others' dependencies. For the live table:

```sh
bun run plan          # all tasks with dependencies and status
bun run plan --next   # tasks that are todo and fully unblocked
bun run plan --check  # validates statuses and dependencies (part of bun run check)
```

| ID                                                       | Task                                                                                         | Lane | Milestone |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---- | --------- |
| [C-01](tasks/C-01-protocol-primitives.md)                | Protocol primitives: branded IDs, base64url, Ed25519, engine ID, hostname claims             | C    | M1        |
| [C-02](tasks/C-02-tunnel-protocol.md)                    | Tunnel handshake schemas and binary frame codec                                              | C    | M1        |
| [C-03](tasks/C-03-registration-registry-heartbeat.md)    | Registration, registry lookup and heartbeat contracts                                        | C    | M1        |
| [R-01](tasks/R-01-sni-parser.md)                         | SNI parser for the TLS ClientHello                                                           | R    | M1        |
| [R-02](tasks/R-02-relay-skeleton.md)                     | Relay skeleton: config, ports, static registry adapter                                       | R    | M1        |
| [R-03](tasks/R-03-tunnel-endpoint.md)                    | Tunnel endpoint: WSS, challenge-response, sessions                                           | R    | M1        |
| [R-04](tasks/R-04-browser-listener.md)                   | Browser listener: SNI routing, stream piping, flow control, limits                           | R    | M1        |
| [M-01](tasks/M-01-mock-engine-tunnel-client.md)          | Mock engine skeleton and tunnel client (N relays, proxy, reconnect)                          | M    | M1        |
| [M-02](tasks/M-02-mock-engine-tls-server.md)             | TLS and HTTP server inside the tunnel, dev CA, spike endpoints                               | M    | M1        |
| [X-01](tasks/X-01-e2e-harness.md)                        | E2E harness: compose stack, Playwright, first browser test                                   | X    | M1        |
| [M-03](tasks/M-03-acme-tls-alpn.md)                      | ACME TLS-ALPN-01 through the relay against Pebble                                            | M    | M1        |
| [X-02](tasks/X-02-spike-network-tests.md)                | Spike network tests: NAT, 443-only, proxies, failover, packet capture                        | X    | M1        |
| [R-05](tasks/R-05-relay-load-test.md)                    | Relay load and throughput test                                                               | R    | M1        |
| [R-06](tasks/R-06-relay-hardening.md)                    | Relay hardening: admission, memory, hostile engines, crash containment                       | R    | M4        |
| [C-04](tasks/C-04-engine-api-contract.md)                | Engine API contract v1 and typed client                                                      | C    | M2        |
| [C-06](tasks/C-06-release-log.md)                        | Release log entry and verification (engine and UI artifacts)                                 | C    | M2        |
| [M-04](tasks/M-04-mock-engine-api.md)                    | Mock engine API: seeded data, scenarios, fault injection, streaming                          | M    | M2        |
| [C-05](tasks/C-05-conformance-suite.md)                  | Conformance suite v1, run against the mock engine                                            | C    | M2        |
| [C-07](tasks/C-07-engine-capabilities.md)                | Engine capabilities: runs, files, triggers, integrations, activity                           | C    | M2        |
| [C-11](tasks/C-11-onboarding-contract-additions.md)      | Onboarding contract additions: registration codes, engine fingerprint                        | C    | M3        |
| [M-07](tasks/M-07-mock-engine-capabilities.md)           | Mock engine capabilities: runs, files, triggers, integrations, live simulation               | M    | M2        |
| [U-01](tasks/U-01-engine-ui-scaffold.md)                 | Engine UI scaffold under the engine's CSP                                                    | U    | M2        |
| [U-02](tasks/U-02-design-system-shell.md)                | Shared UI package, design system, app shell, i18n                                            | U    | M2        |
| [U-03](tasks/U-03-agents.md)                             | Agents: list, detail, control                                                                | U    | M2        |
| [U-04](tasks/U-04-create-edit-agent.md)                  | Create and edit agent: wizard and book editor                                                | U    | M2        |
| [U-05](tasks/U-05-chat.md)                               | Chat with streaming                                                                          | U    | M2        |
| [U-06](tasks/U-06-security-settings.md)                  | Security panel, settings, members, secrets                                                   | U    | M2        |
| [U-07](tasks/U-07-audit-log.md)                          | Audit log view                                                                               | U    | M2        |
| [U-08](tasks/U-08-home-and-activity.md)                  | Home, activity feed and command palette                                                      | U    | M2        |
| [U-09](tasks/U-09-runs.md)                               | Runs: timeline, run detail, cancel and retry                                                 | U    | M2        |
| [U-10](tasks/U-10-files-and-knowledge.md)                | Files and knowledge                                                                          | U    | M2        |
| [U-11](tasks/U-11-triggers-and-schedules.md)             | Triggers and schedules                                                                       | U    | M2        |
| [U-12](tasks/U-12-integrations-and-tools.md)             | Integrations and tools                                                                       | U    | M2        |
| [U-13](tasks/U-13-ux-findings.md)                        | Fix the UX findings from the screenshot pass                                                 | U    | M2        |
| [U-14](tasks/U-14-book-editor-test-chat.md)              | Book editor live test chat                                                                   | U    | M2        |
| [X-03](tasks/X-03-ui-bundle-release.md)                  | UI bundle build, manifest, signing and publishing                                            | X    | M2        |
| [M-05](tasks/M-05-ui-loader.md)                          | UI loader in the mock engine (reference implementation)                                      | M    | M2        |
| [X-04](tasks/X-04-e2e-ui-flows.md)                       | E2E UI flows through relay and loader, CSP violations fail                                   | X    | M2        |
| [E-01](tasks/E-01-engine-integration-guide.md)           | Engine integration guide for the engine team                                                 | E    | M2        |
| [D-01](tasks/D-01-dashboard-scaffold.md)                 | Dashboard scaffold: Vite SPA and Hono API on Workers, D1, environments                       | D    | M3        |
| [D-02](tasks/D-02-accounts-passkeys.md)                  | Accounts, passkeys, sessions (API)                                                           | D    | M3        |
| [D-03](tasks/D-03-engine-registration.md)                | Link codes and engine registration API                                                       | D    | M3        |
| [D-04](tasks/D-04-registry-api.md)                       | Registry API for relays and the relay's HTTP registry adapter                                | D    | M3        |
| [D-05](tasks/D-05-heartbeat-status.md)                   | Heartbeat ingest, Durable Object per engine, offline alerts                                  | D    | M3        |
| [D-06](tasks/D-06-engine-list-ui.md)                     | Engine list and status UI                                                                    | D    | M3        |
| [D-07](tasks/D-07-billing.md)                            | Billing with Stripe and entitlements                                                         | D    | M3        |
| [D-08](tasks/D-08-custom-domains.md)                     | Enterprise custom domains (manual admin flow)                                                | D    | M3        |
| [D-09](tasks/D-09-auth-account-screens.md)               | Sign-up, sign-in, recovery and account screens                                               | D    | M3        |
| [D-10](tasks/D-10-live-link-progress.md)                 | Link flow: trial with a card, live link progress, ready state                                | D    | M3        |
| [D-11](tasks/D-11-install-command-tabs.md)               | Install command tabs from configuration                                                      | D    | M3        |
| [D-12](tasks/D-12-engine-online-emails.md)               | "Engine online" and "back online" emails, offline hint                                       | D    | M3        |
| [R-07](tasks/R-07-tunnel-presence.md)                    | Relay tunnel presence for the dashboard                                                      | R    | M3        |
| [M-06](tasks/M-06-mock-engine-registration-heartbeat.md) | Mock engine registration and heartbeat client                                                | M    | M3        |
| [M-08](tasks/M-08-mock-engine-onboarding.md)             | Mock engine onboarding: setup secret, setup page, operator commands, reference gateway pages | M    | M3        |
| [X-05](tasks/X-05-e2e-dashboard-flow.md)                 | E2E: sign up, link engine, see it online, open it                                            | X    | M3        |
| [X-06](tasks/X-06-local-dev-stack.md)                    | Local dev stack for humans: the whole product on one machine                                 | X    | M3        |
| [X-07](tasks/X-07-e2e-onboarding.md)                     | E2E: onboarding from install command to owner passkey                                        | X    | M3        |
| [X-08](tasks/X-08-dev-stack-address-space.md)            | The dev stack and e2e side by side                                                           | X    | M3        |
| [C-13](tasks/C-13-teams-contracts.md)                    | Teams contracts: member key, access tickets, revocations, heartbeat v2                       | C    | M3        |
| [M-09](tasks/M-09-mock-engine-teams.md)                  | Mock engine: join page, access requests, revocations                                         | M    | M3        |
| [D-13](tasks/D-13-teams-dashboard-api.md)                | Dashboard teams: data, roles, invites, tickets, revocations                                  | D    | M3        |
| [D-14](tasks/D-14-teams-dashboard-ui.md)                 | Dashboard teams screens                                                                      | D    | M3        |
| [D-40](tasks/D-40-metering-core.md)                      | Metering and subscription core: meters, daily history, plan limits                           | D    | M5        |
| [U-15](tasks/U-15-access-requests.md)                    | Engine UI: access requests and dashboard removals                                            | U    | M3        |
| [X-09](tasks/X-09-e2e-teams.md)                          | E2E: invite, approve, remove                                                                 | X    | M3        |
| [I-01](tasks/I-01-relay-hosts.md)                        | Relay hosts: provisioning and hardening                                                      | I    | M4        |
| [I-02](tasks/I-02-dns-cloudflare.md)                     | DNS and Cloudflare environments                                                              | I    | M4        |
| [I-03](tasks/I-03-deploy-pipelines.md)                   | Deploy and release pipelines                                                                 | I    | M4        |
| [I-04](tasks/I-04-observability.md)                      | Monitoring without content                                                                   | I    | M4        |
| [I-05](tasks/I-05-abuse-controls.md)                     | Abuse controls and monitoring jobs                                                           | I    | M4        |
| [I-06](tasks/I-06-security-review.md)                    | Internal security review gate                                                                | I    | M4        |
| [I-07](tasks/I-07-health-checked-relay-dns.md)           | Health-checked relay DNS                                                                     | I    | M4        |
| [I-08](tasks/I-08-web-risk-abuse-feed.md)                | Google Web Risk abuse feed                                                                   | I    | M4        |
| [C-08](tasks/C-08-platform-harness.md)                   | Platform harness, registration and heartbeat conformance suites                              | C    | M5        |
| [C-09](tasks/C-09-tunnel-conformance.md)                 | Tunnel conformance suite: a fake relay the engine dials                                      | C    | M5        |
| [C-10](tasks/C-10-ui-loader-conformance.md)              | UI loader conformance suite: fake release store, test Sigstore, black-box checks             | C    | M5        |
| [C-12](tasks/C-12-one-command-conformance.md)            | The whole conformance run in one command: the engine API suite in harness runs               | C    | M5        |
| [E-02](tasks/E-02-publish-contracts.md)                  | Move the contracts public and consume published versions                                     | E    | M5        |
| [E-03](tasks/E-03-real-engine-swap.md)                   | Run conformance and e2e against the real engine                                              | E    | M5        |
| [E-04](tasks/E-04-engine-agent-kit.md)                   | Engine implementation kit for coding agents                                                  | E    | M5        |
| [E-05](tasks/E-05-onboarding.md)                         | Onboarding: product spec and engine install guide                                            | E    | M3        |
| [C-20](tasks/C-20-owner-handoff-contract.md)             | Owner setup handoff: contract and conformance                                                | C    | M5        |
| [M-15](tasks/M-15-mock-engine-owner-handoff.md)          | Mock engine: the owner setup handoff slot                                                    | M    | M5        |
| [D-39](tasks/D-39-owner-handoff-dashboard.md)            | Dashboard: finish owner setup from the pairing tab                                           | D    | M5        |

## Parallel waves

Tasks in the same wave have no dependencies on each other and can run at the same time, in separate worktrees. Computed from the briefs; regenerate with `bun run plan --waves` after changing dependencies.

| Wave | Tasks                                                                        |
| ---- | ---------------------------------------------------------------------------- |
| 1    | C-01, C-04, D-01, R-01                                                       |
| 2    | C-02, C-03, C-06, C-07, D-02, I-02, U-01                                     |
| 3    | E-01, M-01, R-02, U-02, X-03                                                 |
| 4    | D-09, M-02, M-06, R-03, U-03, U-05, U-06, U-07, U-08, U-09, U-10, U-11, U-12 |
| 5    | D-07, M-04, R-04, U-04                                                       |
| 6    | C-05, D-03, R-05, R-06, U-14, X-01                                           |
| 7    | C-08, C-09, D-04, D-05, E-02, I-01, M-03, M-05, M-07, X-02                   |
| 8    | C-10, D-06, D-08, I-03, I-04, R-07, X-04                                     |
| 9    | C-12, E-05, I-05, I-07, X-05                                                 |
| 10   | C-11, E-03, I-06, I-08, X-06                                                 |
| 11   | E-04, M-08, U-13, X-08                                                       |
| 12   | D-10, D-11, D-12                                                             |
| 13   | X-07                                                                         |

C-01 and R-01 both live in `packages/protocol` and touch its `package.json` and `src/index.ts`; whoever merges second rebases (AGENTS.md, step 7). Wave 1 starts four agents at once; wave 4 is the widest with thirteen.

## Decisions

**Taken** (2026-10-19):

- Porting code from the predecessor UI (ManGo wizard, book editor, chat components in `promptbook/apps/agents-server` and the `agents-server` prototype) is **allowed**. Ported code must still meet the CSP, the engineering rules and our stack.
- Dashboard account recovery: email link that only allows registering a new passkey, under the conditions in D-02.
- Email: `EmailSender` port; Cloudflare Email Service is the current adapter.
- Languages: English and Czech, with i18n from day one in engine-ui and the dashboard.
- Stack: Vite SPAs on TanStack Router, Query, Table and Form with a shared `packages/ui` ([ADR 0007](../adr/0007-frontend-stack.md)); Hono for every HTTP API ([ADR 0008](../adr/0008-hono-for-http-apis.md)); Drizzle with generated, guarded migrations ([ADR 0009](../adr/0009-drizzle-and-migrations.md)).
- Dashboard auth: email-first sign-up, `SameSite=Lax` session with Fetch Metadata CSRF checks, platform admin role. Engine roles: owner, admin, member, viewer.
- Infrastructure as code: OpenTofu and cloud-init. Monitoring: Cloudflare-first; external uptime provider to be specified by Seb.
- Relays route from a stale registry cache for at most 24 hours while the dashboard is unreachable.
- Protocol design principles ([ADR 0010](../adr/0010-protocol-design-principles.md)); wire formats freeze at publication (E-02), after review by the engine team and Pavol. C-01 merges without waiting for it.
- Preassigned ADR numbers: 0011 infrastructure as code (I-01/I-02), 0012 monitoring backend (I-04), 0013 book editor (U-04).
- Tooling: Vitest 4.1 repo-wide; shared versions through the Bun workspace catalog; install scripts only for esbuild, sharp and workerd; generated code not committed, `bun run check` runs `generate` and is the single CI step.
- No branch protection on the current GitHub plan: agents enforce green CI by the procedure in AGENTS.md.
- UI: product brief [docs/design/ui.md](../design/ui.md); three-layer design tokens and one component per module so a later visual pass is a theme change ([ADR 0015](../adr/0015-ui-architecture-and-design-system.md)); role-aware home, guided wizard plus pro editor, mobile-ready core, Stripe-style engine switcher, a distinctive trust mark with an engine fingerprint.
- Engine capabilities discovery with typed contract and UI feature modules: runs, files, triggers, integrations ([ADR 0016](../adr/0016-engine-capabilities.md)).
- Billing through an entitlements port; plans are configuration mapped from Stripe ([ADR 0017](../adr/0017-billing-entitlements.md)).
- Cryptography ([ADR 0014](../adr/0014-cryptography.md)): WebCrypto signs, `@noble/curves` verifies in strict mode; length-prefixed signature inputs; DSSE envelopes instead of JSON canonicalisation; signed tunnel negotiation; trusted time for the update delay; exact Sigstore identity pinning.
- Engine registration is signed by the engine key; regular releases need both the CI's keyless signature and a human-held release key; our own npm scope is exempt from the 7-day release age.
- Organizations, members and roles are modelled from day one ([ADR 0006](../adr/0006-organizations-and-roles.md)).
- Relay DNS failover (I-07, decided 2026-10-23 by the orchestrator, delegated by Seb): the engine wildcard is a Cloudflare DNS-only load balancer with health checks, managed in `infra/cloudflare`, not a checker holding an engine-zone token. Its subscription is a paid add-on (see apply.md); an environment with a single relay (staging for now) uses plain wildcard records instead (`relay_dns_mode`).
- Onboarding (2026-10-26, E-05; [onboarding.md](../design/onboarding.md#decisions)): a dashboard link code inside the install command, `connect --link` for a running engine (CLI only in v0); Docker first (signed multi-arch image, verifying installer, Compose file), npm for local development only; account first promoted, engine first documented; a trial with a card on file before the install command; no engine contract change beyond C-11; the engine image carries its release's UI bundle (installer approves the first bundle by hand until then); MIT token stylesheet and reference gateway pages (M-08).
- Abuse feed (2026-10-26, Seb): Google Web Risk, the commercial Safe Browsing API, backs I-05's `AbuseFeed` port, through its Update API ([I-08](tasks/I-08-web-risk-abuse-feed.md#design-decision-update-api-not-chunked-lookup)); Search Console and Safe Browsing email alerts stay manual setup steps ([abuse-takedown.md](../runbooks/abuse-takedown.md#monitoring-setup-manual-at-apply)).

**Still needed** (each blocks specific tasks, not the start):

| Decision                                                                                                                                                                                                                                                                                                            | Blocks                                    | Owner       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------- |
| Engine domain name (separate from ptbk.io)                                                                                                                                                                                                                                                                          | I-02 (local and staging use placeholders) | Team        |
| Production Cloudflare account and relay VPS provider accounts; for staging, `ptbk.link` in the existing Cloudflare account, with the dashboard on `app.ptbk.io` as a custom hostname of it (decided 2026-11-06; account ID committed, [staging runbook](../staging-runbook.md#1-account-and-domain))                | I-01, I-02                                | Team        |
| Release key holder and the three maintainer key holders (2 of 3 for security releases), hardware keys (e.g. YubiKey 5.7+ PIV for Ed25519) and a rehearsed key ceremony; then the production trust policy engine releases pin ([ui-loader.md](../engine-integration/ui-loader.md#where-the-trust-policy-comes-from)) | X-03 for production signing, I-03         | Team        |
| External audit of the relay and the protocols before general availability: vendor, budget (estimate €15–40k), timing                                                                                                                                                                                                | General availability (after I-06)         | Seb         |
| Who builds the engine side, and when                                                                                                                                                                                                                                                                                | E-03                                      | Engine team |
| GitHub plan: the org stays on Free (decided 2026-11-09). The repository is public, so Actions minutes are free; whether to use environments for deploy secrets is open. Until then, deploys that need a secret run from a maintainer's machine ([deploy runbook](../runbooks/deploy.md#github-settings))            | X-03 and I-03 deploys run by hand         | Seb         |
| Stripe test-mode account (product, price, customer portal settings)                                                                                                                                                                                                                                                 | D-07 manual check                         | Seb         |
| Google Web Risk API key and billing (GCP), before the I-05 production Apply                                                                                                                                                                                                                                         | I-05 production apply                     | Seb         |
| `ops@`, `abuse@` and `security@` mailboxes                                                                                                                                                                                                                                                                          | I-02, I-04, I-05 apply                    | Seb         |
| Confirm the Cloudflare load balancer (paid add-on) and its cost before the production Apply                                                                                                                                                                                                                         | I-07 production apply                     | Seb         |

## How to work a task

See [AGENTS.md](../../AGENTS.md#working-on-a-task) for the full procedure. In short: pick a task from `bun run plan --next`, work in your own worktree and branch, follow the brief's acceptance criteria, update the brief's status line, open a PR, merge when CI is green and the self-review passes.
