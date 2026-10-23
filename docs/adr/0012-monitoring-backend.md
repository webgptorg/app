# 0012. Monitoring backend: Cloudflare first, no new vendor

- **Status:** Proposed
- **Date:** 2026-10-23

## Context

We must know when a relay or the dashboard is down or degraded (spec, Operations: Availability and failure modes), from aggregates that carry no content and no more metadata than the spec allows (spec, Metadata we still see). Every vendor that receives monitoring data is a sub-processor the privacy policy must list; today that list is Cloudflare, Hetzner and Stripe (spec, Legal and GDPR). The spec already puts monitoring jobs on Cloudflare Workers Cron Triggers and monitoring on Cloudflare (Workers observability, Analytics Engine), with an uptime check from outside Cloudflare added later (spec, Hosting and stack). The team chose the Cloudflare-first backend on 2026-10-19 (task I-04); this ADR records how.

The relay speaks raw TCP and TLS and has no HTTP framework ([ADR 0008](0008-hono-for-http-apis.md)); its only HTTP surface is on its own hostname. The dashboard is one Worker with Durable Objects, D1 and an email binding.

## Decision

- **Relays expose metrics, the dashboard pulls them.** Each relay answers `GET /metrics` on its own hostname (the surface ADR 0008 allows) in the Prometheus text format, only with a per-relay metrics token in `Authorization: Bearer`, compared in constant time. It is not the registry token. Every series is an aggregate over all engines and browsers: label sets are closed lists fixed in code, and a label that could carry an engine ID, a hostname, an address or account data is a review blocker, enforced by a label-cardinality test.
- **One Cron Trigger, one dispatcher.** The dashboard Worker's single `scheduled` handler runs every minute and dispatches by cron expression to registered jobs, records each run and failure, and isolates one job's failure from the others. Monitoring is the first job; abuse monitoring (I-05) and later jobs register with the same dispatcher.
- **The monitoring job** checks each relay's TLS handshake and `/healthz`, scrapes its `/metrics` (so the scrape is also the relay uptime check and reads the relay certificate's expiry), checks the dashboard's own health, writes what it saw to **Workers Analytics Engine**, evaluates the alert rules, and sends alerts. One unreachable relay is an alert, not a failed run.
- **Dashboard metrics** (requests by route template, never the raw path; heartbeats, registrations, emails, Durable Object alarms and cron runs by outcome) are written to the same Analytics Engine dataset where they happen. Alert rules that need them read them back with Analytics Engine's SQL API, using an account token that can only read analytics.
- **Alert state** (consecutive failed checks, the last minutes of relay samples, open alerts, job failure streaks) lives in one Durable Object, so rules raise an alert once and clear it once. Rules and their thresholds are domain code with defaults in config, unit-tested without a network.
- **Alerts go to an `AlertSink` port.** The first adapter emails an ops address through the dashboard's existing email binding (`EmailSender`); alerts carry the rule, the relay's short name or the job name, and numbers, nothing else.
- **No other vendor now.** The external uptime check (from outside Cloudflare) comes later, from a provider Seb chooses; it will probe the relays' `/healthz` and the dashboard's `/v1/health` and alert the same ops address, and it is added to the privacy policy then.
- **Retention follows the spec's table.** Workers Logs keep at most 7 days and never carry IPs, emails or tokens; relay logs are journald with `MaxRetentionSec=7day` (I-01); browser IPs and SNI are never logged; per-engine byte counts stay in the relay's memory for one UTC day and are never exported. Analytics Engine keeps its data for three months, which is acceptable only because nothing in it identifies an engine, a person or an account.

## Alternatives considered

- **Grafana Cloud, Better Stack or another SaaS**: a new sub-processor receiving our relay addresses and traffic aggregates, plus a second login and alerting system to maintain.
- **Prometheus and Alertmanager on a Hetzner host**: no new vendor, but one more host to harden, patch and monitor, and its own availability problem.
- **Relays pushing metrics to the dashboard**: the relays would need outbound credentials to a write endpoint, and a dead relay would look like silence instead of a failed check.

## Consequences

- Nothing new in the privacy policy now: Cloudflare already processes the dashboard and its logs.
- When Cloudflare or the dashboard Worker is down, nothing alerts. The external uptime check closes that gap; until then, a dashboard outage is noticed by people.
- A new credential per relay (the metrics token, stored as a relay credential and in a dashboard secret) and one read-only analytics token; the runbook covers their rotation.
- Dashboards are Analytics Engine SQL queries (in the runbook), not a hosted UI; if that becomes painful, Grafana can read Analytics Engine without receiving more data, as a separate decision.
- The scrape interval (one minute) bounds how fast we notice: a relay outage alerts after two failed checks, within three minutes.
