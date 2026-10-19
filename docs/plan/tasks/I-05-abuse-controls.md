# I-05. Abuse controls and monitoring jobs

- **Lane:** I · **Module:** `apps/dashboard`, `apps/relay`, `infra/cloudflare`, `docs/runbooks` · **Milestone:** M4
- **Depends on:** R-04, D-05, D-07 · **Unblocks:** I-06
- **Status:** todo
- **Spec:** Abuse on our domains (all items); Relay and tunnel (Fairness and DoS on a shared relay); Interfaces (draft) 2 (`suspended`); Hosting and stack (Monitoring jobs; CT monitor; Known hard problems, Let's Encrypt rate limits); Metadata we still see

## Goal

Our engine domain can withstand abuse: rate limits and per-engine fairness limits are set and proven, a platform admin can suspend an engine and the relays stop routing it, an abuse contact and takedown runbook exist, Cron Trigger jobs watch Certificate Transparency, engines' public faces and abuse feeds, and the Public Suffix List request is submitted.

## Context

Anyone can modify the open-source engine and serve anything on `<engineId>.<engine domain>`, and we cannot inspect it by design. One phishing page could get the whole domain blocked. The spec layers mitigations so no single one has to be perfect; the target for a confirmed report is takedown within hours. This task touches three modules; split it into PRs per module (dashboard, relay, infra and docs), each referencing I-05.

## Scope

- **Rate limits review** (dashboard): confirm every anonymous endpoint has one (signup, sign-in, recovery, registration, heartbeat, registry, webhooks) and move the values into one documented config block. Add D-03's "card on file" rule: an `EngineCreationPolicy` adapter that denies `billing-required` unless the org's D-07 billing state is `active` or `trialing` (fake billing in dev and e2e passes).
- **Relay fairness** (relay): R-04 implements the limit mechanics; here set production values per engine (concurrent browser connections, new connections per second, bandwidth as a token bucket) and per client IP (connections to the browser listener, tunnel auth attempts), add any limit R-04 left out, and expose them in config. Prove them with a test where one engine is flooded while another engine's connection latency stays within 2x its baseline.
- **Suspend flow** (dashboard): admin page `/admin/engines/$engineId` with suspend and unsuspend (reason required), via `Authorizer` action `admin.engine.suspend` (platform admin, `requiresStepUp`), audit-logged. Suspension sets `engines.status = 'suspended'`; D-04's registry returns it, relays close the tunnel within one cache TTL and refuse new ones; registration with that key returns 403 (D-03). Custom hostnames of a suspended engine are withheld from the registry. The org owner sees "suspended" in D-06 with the abuse contact.
- **Abuse contact**: `abuse@` address (and on the engine domain's registrar record), a public `/abuse` page on the dashboard (English and Czech) with how to report and what we can and cannot see, `security.txt` on the dashboard.
- **Takedown runbook** `docs/runbooks/abuse-takedown.md`: triage, evidence we can collect (public page only), suspend, notify the org owner, appeal and unsuspend, legal hold, records kept and for how long.
- **Monitoring jobs** as Cron Triggers in the dashboard (`scheduled` handler dispatching by cron expression), each behind a port with a fake, with state in D1 (migration: `ct_certs(cert_sha256 PK, source, first_seen_at, hostnames, issuer, alert)`, `ct_cursors(source PK, cursor)`, `public_face_checks(engine_id, checked_at, result, fingerprint)`):
  - **CT watch**: every 15 minutes query crt.sh and Cert Spotter for the engine domain; alert on a wildcard certificate, a non-Let's Encrypt issuer, a hostname that is not a registered engine hostname, or an unusual issuance count for one engine. Two sources, so one being down only degrades. (Engines run their own per-key CT check; this one is ours.)
  - **Public-face check**: visit each active engine hostname anonymously, without cookies or redirects followed off-host, and compare the response with the known engine sign-in page fingerprint; record `match`, `mismatch` or `unreachable`; alert on `mismatch`; never auto-suspend. Spread engines across runs to stay within Workers subrequest limits; each engine at least daily.
  - **Abuse feeds**: an `AbuseFeed` port with adapters for the providers the team picks (see open points); alert when an engine hostname appears.
- **PSL**: add the `_psl` TXT record through I-02's code, open the pull request to `publicsuffix/list`, record its URL in the runbook; request a Let's Encrypt rate-limit increase for the engine domain.

## Out of scope

- Terms of service and privacy policy text (legal); takedown automation; ECH.

## Design notes

- Alerts go through I-04's `AlertSink`; abuse alerts to the abuse inbox.
- The public-face check reads only what any anonymous visitor sees; it must be disclosed in the privacy policy (spec). Its known limit: a modified engine can show our checker a clean page.
- Store only certificate metadata and fingerprints from checks, never page bodies.

## Acceptance criteria

- [ ] Workers tests: suspend requires platform admin and fresh step-up; audit row written; registry returns `suspended` and omits custom hostnames; registration with a suspended key → 403; `billing-required` denies link codes for an org without an active subscription.
- [ ] Relay test: a suspended entry closes an open tunnel within one TTL (fake clock); flood test for fairness passes.
- [ ] CT watch tests with recorded fixtures from both sources: wildcard, foreign issuer, unknown hostname each alert once; a source timing out does not fail the run.
- [ ] Public-face tests: match, mismatch, unreachable, redirect to another host treated as mismatch.
- [ ] `/abuse` page live on staging in both languages; runbook merged; PSL pull request URL recorded (or blocked on the engine domain name, stated in the PR).
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- **Engine domain name** is undecided; the PSL request and production CT watch wait on it.
- The engine sign-in page fingerprint must come from the engine team (a stable marker per engine version); use the mock engine's page until then.
- Abuse feed providers: Google Safe Browsing's API is for non-commercial use (Web Risk is the commercial one), PhishTank's API registration has been unreliable, Netcraft is a commercial service. Team to choose; Search Console and Safe Browsing email alerts for the domain are manual setup steps listed in the runbook.
- Public agents on the default engine domain (spec open question) change how noisy the public-face check is.
