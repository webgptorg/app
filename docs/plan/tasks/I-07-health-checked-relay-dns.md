# I-07. Health-checked relay DNS

- **Lane:** I · **Module:** `infra/cloudflare`, `apps/dashboard` (health check job), `e2e/` · **Milestone:** M4
- **Depends on:** I-01, I-02, I-04
- **Status:** in progress (feat/i-07-relay-dns-failover)
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

Tracked in [apply.md](../apply.md). Needs I-01's and I-02's applied staging, the Load Balancing add-on and the ops mailbox.

- Verify the load balancer against the staging relays (`infra/cloudflare` README, Relay DNS); record what production resolvers do with the short TTL.

## Risks and open points

- **Decided 2026-10-23 (the orchestrator, delegated by Seb): option 1, a Cloudflare DNS-only load balancer.** The conflict with I-02: a checker that edits the engine domain's relay records needs a privileged token where I-02 forbids one, and its edits drift from the OpenTofu state, so the next `apply` would put a hung relay back. Options were (1) a DNS-only load balancer with health checks on the engine wildcard, or (2) a separate Worker holding a token scoped to the engine zone, with the relay records outside OpenTofu. Option 2 is rejected: Cloudflare tokens cannot be scoped below a zone, so that Worker could repoint any engine hostname and pass ACME challenges for it, which is what the zero-trust credential rule forbids for relays. With option 1 no token exists at runtime, and the relay records stay in OpenTofu:
  - `infra/cloudflare/modules/environment/relay-dns.tf`: the load balancer on `*.<engine domain>` (DNS-only, TTL 30 s) replaces I-02's wildcard A and AAAA records. One primary pool with every relay address at equal weight, because a DNS-only load balancer then answers with every healthy endpoint of the pool and drops only the unhealthy ones (one pool per relay would answer with one relay per query and lose the browser's own retry of the next address). An HTTPS monitor asks each relay's own hostname for `/healthz` (certificate verified, 3 s timeout, one retry, every 15 s, out after 2 failures, back after 3 passes) from three regions, and Cloudflare counts a relay unhealthy only when most regions see it fail. A fallback pool holds the same relays without a monitor, so if every relay fails, every relay stays listed and the notification policy alerts the ops mailbox, as it does for every pool and endpoint health change.
  - To confirm at Apply: a DNS-only load balancer on a wildcard hostname (Cloudflare documents wildcard load balancer records, not this combination); A answers carry only the IPv4 endpoints and AAAA answers only the IPv6 ones, and what an A query gets while every IPv4 endpoint is down but an IPv6 one is healthy (the pool counts as healthy); the monitor sends the Host header as the TLS server name. If the wildcard does not work DNS-only, the fallback is option 2 behind a `RelayDnsWriter` port, the seam the e2e stand-in already has (`e2e/src/relay-dns/checker.ts`), with its own ADR; it is documented, not built.
  - The e2e stand-in (`compose.relay-dns.yaml`, `e2e/src/relay-dns/`) applies the same rule to the stack's CoreDNS and is test-only; nothing of it ships with the dashboard, whose `scheduled` dispatcher gets no I-07 job.

- DNS caching beyond the TTL (resolvers, operating systems, browsers) delays failover; the e2e test measures it with Chromium only. Record what production resolvers do once relays run in staging. Production failover takes about interval × consecutive down + TTL, 15 × 2 + 30 = 60 s plus resolver caching (`infra/cloudflare` README, Relay DNS).
- A check from one location can remove a relay that is only unreachable from there; use more than one vantage point or a quorum before removing a relay in production. I-01 spreads relays over several providers, so a single provider's outage must not read as every relay failing. Addressed: three check regions with Cloudflare's majority rule, and the fallback pool when every relay fails.
- A relay under a TLS-handshake flood (R-06) can look hung to the checker; thresholds must not pull a relay that is only shedding load, or an attack on one relay could take it out of DNS. Partly addressed: two failed checks in a row from most regions, each with a retry; R-06 keeps part of its connection cap for the relay's own hostname, which is what the monitor asks for, but its budget for connections still before their ClientHello is shared and evicts the oldest under a flood, so a heavy handshake flood can still fail the checks. A relay that cannot finish a handshake for 30 s from most regions is failing browsers too, so leaving DNS is then the right outcome; a flood against every relay ends in the fallback pool, not in empty DNS.
