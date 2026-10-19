# I-04. Monitoring without content

- **Lane:** I · **Module:** `apps/relay` (metrics), `apps/dashboard` (metrics, uptime and alert jobs), `infra/` · **Milestone:** M4
- **Depends on:** I-01, I-02 · **Unblocks:** I-06
- **Status:** todo
- **Spec:** Metadata we still see; Operations (Availability and failure modes); Hosting and stack (Monitoring jobs); Legal and GDPR (sub-processors); docs/engineering.md (Logging and metadata)

## Goal

We know when relays or the dashboard are down or degraded, from aggregate metrics, uptime checks and alerts that carry no content and no more metadata than the spec's table allows, and logs are kept no longer than that table says.

## Context

The relay pipes ciphertext and must log only what "Metadata we still see" lists, kept short. Metrics are aggregates: no engine IDs, hostnames, IPs or account data as labels. This task touches two apps and infra; land it as separate PRs per module if that keeps them small, each referencing I-04. Adding a monitoring vendor adds a sub-processor that the privacy policy must list (spec lists Cloudflare, Hetzner, Stripe), so a Cloudflare-first setup is preferred.

## Scope

- Backend (decided 2026-10-19): **Cloudflare-first**, recorded as an ADR with the next free number: relays expose metrics on an authenticated `GET /metrics` on their own hostname; a dashboard Cron Trigger scrapes every relay every minute, writes to Workers Analytics Engine, evaluates alert rules and sends alerts. The scrape doubles as a relay uptime check. No other vendor in this task.
- Relay metrics (counters and gauges, Prometheus text format, a `Metrics` port with an in-memory fake): active tunnels; tunnel connects, disconnects and auth failures by reason; active browser connections; browser connections by outcome (`routed`, `unknown-sni`, `no-sni`, `limit`); bytes in and out (aggregate); time from ClientHello to stream open (histogram); registry lookups by result (`fresh`, `stale`, `miss`, `error`) and latency; process memory, event-loop lag, open file descriptors; own certificate expiry timestamp. `/metrics` requires a separate metrics token (not the registry token).
- Dashboard metrics: requests by route template (never the raw path) and status; heartbeats by outcome; registrations by outcome; Durable Object alarms fired; emails sent and failed; cron job runs and failures.
- Uptime checks (Cron Trigger, every minute): each relay's TLS handshake and `/healthz` on its own hostname; dashboard `/v1/health`; the relay certificate's days to expiry. An external uptime check from outside Cloudflare comes later; Seb will specify the provider. Leave a documented hook (health endpoints and alert routing) for it.
- Alert rules (initial thresholds in config, documented): relay unreachable 2 checks in a row; active tunnels drop by more than 50 % within 5 minutes; registry `error` or `stale` rate above 5 % for 10 minutes; heartbeat rejections spike; relay cert expires in under 14 days; any cron job failing 3 times; email send failures. Alerts go to an `AlertSink` port (email via `EmailSender` to an ops address by default).
- Log retention per the spec's table, enforced and documented in `docs/runbooks/observability.md`:
  - relay: engine IP and tunnel connect/disconnect events at most 7 days (journald `MaxRetentionSec=7day` from I-01); browser IPs not logged by default; per-engine byte counts, if kept for abuse handling, aggregated per day and dropped after 24 h, never linked to accounts; SNI never stored;
  - dashboard: Workers Logs retention at or below 7 days; no IPs, emails or tokens in log fields; heartbeat values held only in the Durable Object (30 days, D-05).
- A relay test that asserts every log event type has a fixed field allowlist and that no event type contains a browser IP or SNI field.

## Out of scope

- Abuse monitoring jobs (CT watch, public-face check, feeds) in I-05; a public status page (v1 target per the spec).
- Tracing or any per-request payload capture.

## Design notes

- Metric names prefixed `ptbk_relay_` and `ptbk_dashboard_`; label sets fixed and small; adding a label with engine-level cardinality is a review blocker.
- The scrape job tolerates one relay being down and alerts on it rather than failing the whole run.
- Compare the metrics token in constant time.

## Acceptance criteria

- [ ] ADR merged and listed in `docs/adr/README.md`.
- [ ] Relay unit tests for the metrics port; `/metrics` returns 401 without the token and the documented series with it; no series carries an engine ID, hostname or IP label (test).
- [ ] Staging: dashboards or queries show tunnels, connections, bytes, errors and latency for the staging relay while the mock engine runs through it (screenshot in the PR).
- [ ] Stopping the staging relay raises an alert within 3 minutes; restarting it clears it.
- [ ] Log field allowlist test passes; journald retention verified on staging hosts.
- [ ] Runbook written; `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Backend choice (ADR) and any new sub-processor need team sign-off and a privacy policy update.
- The external uptime provider (to be specified by Seb) will be a new sub-processor; add it to the privacy policy then.
- Where alerts go besides email (chat, phone) and who is on call are team decisions.
