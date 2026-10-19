# D-08. Enterprise custom domains (manual admin flow)

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-04 · **Unblocks:** — (part of the M4 security review scope)
- **Status:** todo
- **Spec:** Relay and tunnel (Enterprise custom domains); Residual risks (Custom domain, strict mode); Interfaces (draft) 2 and 6 (`PTBK_CUSTOM_DOMAIN`); Migrating existing engines; ADRs: [0006](../../adr/) (Organizations, members and roles from day one)

## Goal

A platform admin can attach a customer's hostname to one engine with the engine-signed claim, verify its CNAME, and the hostname then appears in the registry so relays route it and the engine can obtain its own certificate for it.

## Context

Custom domains are Enterprise only and set up by hand with each customer; there is no self-service. Security does not depend on this flow: the relay routes a custom hostname only if its claim, signed by the engine key over `"ptbk-hostname-v1" | hostname | engineId`, verifies (D-04 relay adapter). The dashboard checks the claim too, so admins get immediate feedback, and checks the CNAME as operational hygiene. Custom hostnames belong to an engine, which belongs to an organization; organization owners see them read-only.

## Scope

- Migration `0006_engine_hostnames.sql`: `engine_hostnames(hostname TEXT PK, engine_id TEXT NOT NULL REFERENCES engines, org_id TEXT NOT NULL, claim_sig TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending-dns','active')), dns_checked_at INTEGER, created_at INTEGER NOT NULL, created_by_user_id TEXT NOT NULL)`.
- D1 adapter for D-04's `EngineHostnameStore` returning only `active` rows with their claims, so the registry response includes them.
- Authorizer action `admin.hostnames.manage`: platform admin only, `requiresStepUp`. Every change writes `admin_audit_log` (action, engine ID, hostname).
- Admin pages (strings through i18n) at `/admin/engines/$engineId/hostnames`:
  - Add: hostname + claim signature (base64url). Server checks in order: hostname normalised (lowercase, trailing dot removed, IDNs as A-labels, max 253 chars) and valid per the protocol `Hostname` schema; not an IP; no wildcard; not under the engine domain, `ptbk.io` or a relay domain (config list); not already assigned; claim verifies against the engine's public key with the C-01 function. Stored as `pending-dns`.
  - "Check DNS": resolves through a `DnsResolver` port; `active` when the hostname's CNAME target equals the expected target (see open points). Otherwise shows what was found.
  - Remove: deletes the row after confirmation.
- Organization owners see active custom hostnames on D-06's engine detail page, read-only. The org-facing action `engine.hostnames.manage` (`sensitive`, from D-02) stays without a route in v0.
- `DnsResolver` port: `resolveCname(hostname, signal) → { kind: 'cname', target } | { kind: 'none' } | { kind: 'error' }`. Adapter: DNS over HTTPS JSON API (`https://cloudflare-dns.com/dns-query`, `accept: application/dns-json`, 3-second timeout); in-memory fake for tests.
- Runbook `docs/runbooks/custom-domain.md`: what the customer does (CNAME record, `PTBK_CUSTOM_DOMAIN`, producing the claim on the engine), what the admin does, how to verify through the relay, how to remove.

## Out of scope

- Self-service custom domains; apex domains (a CNAME cannot sit at an apex).
- Relay-side claim verification and routing (D-04); certificate issuance (the engine).

## Design notes

- Domain service `addCustomHostname(deps, input) → { kind: 'added' } | { kind: 'invalid-hostname' } | { kind: 'reserved-domain' } | { kind: 'taken' } | { kind: 'bad-claim' } | { kind: 'engine-not-found' }`.
- Only `active` rows reach relays. CNAME first, then the relay routes the hostname, then the engine's TLS-ALPN-01 challenge can pass through the relay.
- Removal reaches relays within one cache TTL (5 minutes).

## Acceptance criteria

- [ ] Unit tests for `addCustomHostname`, one per outcome, with a claim signed by a test key from the protocol package and a claim signed by another key (`bad-claim`), a claim for a different hostname (`bad-claim`) and one for a different engine ID (`bad-claim`).
- [ ] Hostname normalisation tests: uppercase, trailing dot, Unicode IDN, IP literal, `*.example.com`, a subdomain of the engine domain, a 254-character name.
- [ ] Workers tests: non-admin → 403; admin without fresh step-up → 403; add, check DNS with the fake resolver (`pending-dns` stays on a wrong target, `active` on the right one), and the registry endpoint from D-04 then lists the hostname with its claim; removal drops it from the registry; audit rows written.
- [ ] Relay integration test (in `apps/relay`, using the HTTP adapter against a fake registry) shows an active custom hostname routed and a tampered claim dropped; reuse D-04's tests if they already cover it.
- [ ] Runbook written; schema allowlist updated; `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- **CNAME target** is not specified: the engine's default hostname (`<engineId>.<engine domain>`, which keeps working when relays federate) or a shared relay name. Default to the engine's default hostname and confirm with the team.
- How the claim gets from the engine to us (CLI output the customer sends, or a future API field) is up to the engine team; Interface 1 has no field for it. Coordinate through E-01.
- Periodic re-verification of CNAMEs is not planned; a dangling record does not misroute anything, it only stops working.
