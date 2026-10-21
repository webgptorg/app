# I-07. Health-checked relay DNS

- **Lane:** I · **Module:** `infra/cloudflare`, `apps/dashboard` (health check job), `e2e/` · **Milestone:** M4
- **Depends on:** I-01, I-02, I-04
- **Status:** todo
- **Spec:** Relay and tunnel (failover); Operations (Availability and failure modes); Hosting and stack (Engine DNS, Monitoring jobs)

## Goal

A relay that stops completing TLS handshakes leaves the engine domain's DNS quickly, so browsers stop being sent to it, and returns once it recovers.

## Context

X-02 measured (2026-10-21) that a relay which hangs while its kernel still accepts TCP (`docker pause`) is not failed over by Chromium: it tries an engine hostname's A records one after another and moves on only when a connect fails. Here the connect succeeds and the TLS handshake stalls, so the page waited 30,055 ms and failed with `ERR_TIMED_OUT` without trying the other relay. A dead relay (port refused) or one that has vanished from the network (no answer at all) fails over in well under a second; a hung one does not. Browsers cannot be changed, so the fix is in DNS: a hung relay must stop being listed.

## Scope

- An external health check, outside the relays (a dashboard Cron Trigger job registered with I-04's `scheduled` dispatcher, or Cloudflare's own health checks if they fit), that completes a TLS handshake with each relay on its own hostname and on a test engine hostname every few seconds to a minute, with a short handshake timeout. A relay is unhealthy after a few consecutive failures and healthy again after a few successes.
- When a relay turns unhealthy, its A records are removed from the engine domain's wildcard (I-02's records, through the Cloudflare API with a token scoped to that zone); when it recovers, they come back. That token lives with the checker, never on a relay host: I-01 keeps DNS credentials for the engine domain off relays. Never remove the last healthy relay: if every relay fails, keep the records and alert instead (a checker outage must not take every engine offline).
- A short TTL on the engine domain's relay records (for example 30 to 60 s) so the change reaches browsers quickly; document what it costs in DNS queries.
- Alerts through I-04 when a relay leaves or rejoins DNS. No engine IDs, hostnames or IPs beyond the relay's own in alerts or logs.
- E2E: in X-02's stack, a stand-in for the checker and for the engine domain's DNS (CoreDNS) that drops a relay that stops completing handshakes, so the hung-relay case can be tested end to end.

## Out of scope

- Inter-relay forwarding. Changing the relay's own TLS behaviour. Browser-side workarounds.

## Acceptance criteria

- [ ] X-02's known-limit test (`e2e/tests/network/relay-failover.spec.ts` › "a hung relay that still accepts TCP is not failed over by the browser (known limit, I-07)") is turned into a passing failover test: with relay-a paused and listed first, a fresh browser loads the engine through relay-b in under 15 s, counted from the moment the relay hung.
- [ ] Unit tests for the checker: consecutive failure and success thresholds, never removing the last healthy relay, alert on every change.
- [ ] The engine domain's relay records carry the short TTL, set in infra code.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Apply (needs credentials)

Tracked in [apply.md](../apply.md). Needs I-01's and I-02's applied staging and the decision below.

- The checker runs against the staging relays and changes the staging records; record what production resolvers do with the short TTL.

## Risks and open points

- **Conflict with I-02, needs a human decision.** I-02 keeps every DNS token out of the dashboard Worker, and the engine domain's relay records are managed by OpenTofu: a checker that edits them needs a privileged token where I-02 forbids one, and its edits drift from the OpenTofu state, so the next `apply` would put a hung relay back. Options: Cloudflare's own health checks (Load Balancing; not yet confirmed to work for DNS-only wildcard records), or a dedicated token scoped to the engine zone held only by the checker, with the relay records excluded from OpenTofu. Build the checker logic, thresholds and the CoreDNS e2e behind a `RelayDnsWriter` port now; the adapter waits for the decision (plan's "Still needed" table).

- DNS caching beyond the TTL (resolvers, operating systems, browsers) delays failover; the e2e test measures it with Chromium only. Record what production resolvers do once relays run in staging.
- A check from one location can remove a relay that is only unreachable from there; use more than one vantage point or a quorum before removing a relay in production. I-01 spreads relays over several providers, so a single provider's outage must not read as every relay failing.
- A relay under a TLS-handshake flood (R-06) can look hung to the checker; thresholds must not pull a relay that is only shedding load, or an attack on one relay could take it out of DNS.
