# I-02. DNS and Cloudflare environments

- **Lane:** I · **Module:** `infra/cloudflare` (and `apps/dashboard/wrangler.jsonc` IDs) · **Milestone:** M4
- **Depends on:** D-01
- **Status:** todo
- **Spec:** One address for users; Residual risks (1. Certificate mis-issuance); Abuse on our domains (items 1, 2 and Before the PSL entry lands); Hosting and stack (Engine DNS); Operations

## Goal

Separate Cloudflare environments for staging and production exist from code, with the engine domain wildcard (DNS-only) pointing at every relay, relay hostnames, the dashboard's custom domain, the dashboard's D1 databases and the email sending domain, all with placeholders until the engine domain name is chosen.

## Context

Engine hostnames must never be proxied by Cloudflare: proxying would terminate TLS at Cloudflare and break the zero-trust guarantee. The engine domain is a separate registrable domain from `ptbk.io`, used for nothing else, so a browser block cannot take down the dashboard or mail. Browsers find all relays through DNS and retry the next IP when one is down. The dashboard runs on Workers with a custom domain. The name of the engine domain is an open team decision; staging and local use placeholders. A second DNS provider is v1.

## Scope

- OpenTofu with the Cloudflare provider (decided 2026-10-19), recorded in ADR 0011 (infrastructure as code), shared with I-01: whichever of the two starts first writes it, the other reuses it. Code under `infra/cloudflare/` with one stack per environment.
- Environments: separate Cloudflare accounts (or at minimum separate zones and API tokens) for staging and production, so a staging token can never change production. Dev stays local.
- Engine domain zone (placeholder `ENGINE_DOMAIN`, a separate staging domain or subdomain):
  - `*.<engine domain>` A and AAAA to every relay in that environment, `proxied = false`, TTL 60 s;
  - no record that serves anything on the bare engine domain;
  - CAA: `0 issue "letsencrypt.org"`, `0 issuewild ";"` (no wildcard certificates, so any mis-issuance is per hostname and visible), `0 iodef "mailto:<security address>"`;
  - DNSSEC enabled where the registrar supports it.
- Relay hostnames (`relay-fsn`, `relay-hel` under the relay domain, placeholder `RELAY_DOMAIN`): A and AAAA, DNS-only.
- Dashboard: Workers custom domain `app.ptbk.io` (production) and the staging equivalent; D1 databases `ptbk-dashboard-staging` and `ptbk-dashboard-production`; real IDs written into `apps/dashboard/wrangler.jsonc` (touches the dashboard module's config only).
- Email sending domain for Cloudflare Email Service (D-02 and D-05): SPF, DKIM and DMARC (`p=reject` once verified) records on the sending domain under `ptbk.io`, never on the engine domain.
- API tokens, least privilege, documented in `infra/cloudflare/README.md`: a deploy token per environment for Workers scripts, D1 and Durable Objects on the dashboard only (used by I-03); a DNS token per environment for IaC runs by humans. No DNS token on relays or in the dashboard Worker.
- Account hardening: hardware-key 2FA for every member, audit log review documented.
- Runbook section: removing a dead relay from the wildcard and re-adding it.

## Out of scope

- Relay hosts (I-01); deploy workflows (I-03); uptime checks (I-04); PSL submission and CT watch (I-05).
- Second DNS provider and per-engine records for federation (v1 and later).

## Design notes

- A test in `infra/cloudflare/` (or a plan check in CI) fails if any record under the engine domain has `proxied = true`.
- Low TTL on the wildcard makes removing a dead relay effective within a minute; browsers already retry other IPs.
- Per-engine CAA `accounturi` pinning (RFC 8657) needs per-engine records and is not possible with one wildcard; it waits for per-engine records.

## Acceptance criteria

- [ ] Staging stack applied: `dig +short anything.<staging engine domain>` returns every staging relay address (A and AAAA); the records are DNS-only (checked through the Cloudflare API in the PR).
- [ ] CAA records present and `issuewild ";"` verified; DNSSEC status recorded.
- [ ] Staging dashboard reachable on its custom domain after an I-03 deploy (or a manual `wrangler deploy` for this check).
- [ ] The "no proxied engine records" check exists and fails on a deliberately proxied record in a test.
- [ ] Email test from staging passes SPF, DKIM and DMARC (headers in the PR).
- [ ] Token scopes documented and verified (deploy token cannot edit DNS).
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- **Engine domain name** is undecided (team decision; it must be separate from `ptbk.io`). Production cannot be applied until it is chosen; the PSL application (I-05) waits on it too.
- Whether `ptbk.io` is already on Cloudflare, and in which account.
- Relay domain: under the engine domain or a separate infra domain.
- Separate Cloudflare accounts versus one account with strict tokens: confirm with whoever holds the accounts.
