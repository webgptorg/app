# D-08. Enterprise custom domains (manual admin flow)

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-04, D-09
- **Status:** done (#63)
- **Spec:** Relay and tunnel (Enterprise custom domains); Residual risks (Custom domain, strict mode); Interfaces (draft) 2 and 6 (`PTBK_CUSTOM_DOMAIN`); Moving existing deployments; ADRs: [0006](../../adr/0006-organizations-and-roles.md), [0014](../../adr/0014-cryptography.md)

## Goal

A platform admin can attach a customer's hostname to one engine with the engine-signed claim, verify its CNAME, and the hostname then appears in the registry so relays route it and the engine can obtain its own certificate for it.

## Context

Custom domains are Enterprise only and set up by hand with each customer; there is no self-service. Security does not depend on this flow: the relay routes a custom hostname only if (a) its claim, signed by the engine key over `"ptbk-hostname-v1" | hostname | engineId` (encoded with `signingInput`, ADR 0014), verifies and (b) the hostname's DNS CNAME resolves to exactly that engine's default hostname, C-03's `expectedCnameTarget(engineId, engineDomain)` = `<engineId>.<engine domain>` (R-02's `DnsResolver`, re-checked at every 5-minute registry refresh). The relay enforces both, so even a compromised dashboard cannot redirect a customer domain: it cannot forge a claim without the engine key, and it cannot change the customer's DNS. The dashboard checks the claim and the CNAME too, but only so admins get immediate feedback. Custom hostnames belong to an engine, which belongs to an organization; organization owners see them read-only.

## Scope

- Table in `src/adapters/db/schema.ts` (drizzle-kit generates the migration):

  ```ts
  export const engineHostnames = sqliteTable(
    'engine_hostnames',
    {
      hostname: text('hostname').primaryKey(),
      engineId: text('engine_id')
        .notNull()
        .references(() => engines.engineId),
      orgId: text('org_id').notNull(),
      claimSig: text('claim_sig').notNull(),
      status: text('status', { enum: ['pending-dns', 'active'] }).notNull(),
      dnsCheckedAt: integer('dns_checked_at'),
      createdAt: integer('created_at').notNull(),
      createdByUserId: text('created_by_user_id').notNull(),
    },
    (t) => [check('engine_hostnames_status_check', sql`${t.status} in ('pending-dns', 'active')`)],
  );
  ```

- D1 adapter (Drizzle) for D-04's `EngineHostnameStore` returning only `active` rows with their claims, so the registry response includes them.
- Authorizer action `admin.hostnames.manage`: platform admin only, `requiresStepUp`. Every change writes `admin_audit_log` (action, engine ID, hostname).
- Admin SPA route `/admin/engines/$engineId/hostnames`, built from `@ptbk/ui` components in D-09's admin shell, with the hostnames in a `DataTable`, strings through i18n; each action below is an `/api/admin/engines/:engineId/hostnames` endpoint declared in D-01's route table:
  - Add: hostname + claim signature (base64url). Server checks in order: hostname normalised (lowercase, trailing dot removed, IDNs as A-labels, max 253 chars) and valid per the protocol `Hostname` schema; not an IP; no wildcard; not under the engine domain, `ptbk.io` or a relay domain (config list); not already assigned; claim verifies against the engine's public key with the C-01 function. Stored as `pending-dns`.
  - "Check DNS": resolves through a `DnsResolver` port; `active` when the hostname's CNAME target equals C-03's `expectedCnameTarget(engineId, engineDomain)` (`<engineId>.<engine domain>`, not a relay name), the same comparison the relay makes. The page always shows the expected target next to each hostname, so the admin can hand it to the customer, and on a mismatch shows what was found.
  - Remove: deletes the row after confirmation.
- Organization owners see active custom hostnames on D-06's engine detail page, read-only. The org-facing action `engine.hostnames.manage` (`sensitive`, from D-02) stays without a route in v0.
- `DnsResolver` port: `resolveCname(hostname, signal) → { kind: 'cname', target } | { kind: 'none' } | { kind: 'error' }`. Adapter: DNS over HTTPS JSON API (`https://cloudflare-dns.com/dns-query`, `accept: application/dns-json`, 3-second timeout); in-memory fake for tests.
- Runbook `docs/runbooks/custom-domain.md`: what the customer does (a CNAME record from the custom hostname to `<engineId>.<engine domain>`, never to a relay; apex domains are not supported in v0; `PTBK_CUSTOM_DOMAIN`, producing the claim on the engine), what the admin does, how to verify through the relay, how to remove.

## Out of scope

- Self-service custom domains; apex domains in v0 (a CNAME cannot sit at an apex, and the relay's DNS check requires one).
- Relay-side claim verification, DNS check and routing (C-03, R-02, D-04); certificate issuance (the engine).

## Design notes

- Domain service `addCustomHostname(deps, input) → { kind: 'added' } | { kind: 'invalid-hostname' } | { kind: 'reserved-domain' } | { kind: 'taken' } | { kind: 'bad-claim' } | { kind: 'engine-not-found' }`.
- Only `active` rows reach relays. CNAME first, then the relay routes the hostname, then the engine's TLS-ALPN-01 challenge can pass through the relay.
- Removal reaches relays within one cache TTL (5 minutes). A customer who repoints the CNAME elsewhere stops routing at the relay's next DNS re-check, whatever the dashboard says.

## Acceptance criteria

- [x] Unit tests for `addCustomHostname`, one per outcome, with a claim signed by a test key from the protocol package and a claim signed by another key (`bad-claim`), a claim for a different hostname (`bad-claim`) and one for a different engine ID (`bad-claim`).
- [x] Hostname normalisation tests: uppercase, trailing dot, Unicode IDN, IP literal, `*.example.com`, a subdomain of the engine domain, a 254-character name.
- [x] Workers tests: non-admin → 403; admin without fresh step-up → 403; add, check DNS with the fake resolver (`pending-dns` stays on a wrong target, `active` on the right one), and the registry endpoint from D-04 then lists the hostname with its claim; removal drops it from the registry; audit rows written.
- [x] Relay integration test (in `apps/relay`, using the HTTP adapter against a fake registry) shows an active custom hostname routed, a tampered claim dropped, and a hostname with a valid claim but a CNAME (fake `DnsResolver`) pointing elsewhere, at a relay name or missing not routed; reuse D-04's tests if they already cover it. Covered by D-04's tests: `apps/relay/src/adapters/http-engine-registry.test.ts` (HTTP adapter: an active custom hostname routed, a foreign claim dropped) and `apps/relay/src/domain/hostname-policy.test.ts` (a valid claim with a CNAME elsewhere, at a relay name, at the engine domain or missing is not routed).
- [x] Runbook written ([apps/dashboard/runbooks/custom-domain.md](../../../apps/dashboard/runbooks/custom-domain.md), inside the module rather than `docs/runbooks/`); migration is drizzle-kit output and passes D-01's guards; schema allowlist updated; `bun run check` passes.
- [x] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- How the claim gets from the engine to us (CLI output the customer sends, or a future API field) is up to the engine team; Interface 1 has no field for it. Coordinate through E-01.
- The dashboard does not re-verify CNAMEs periodically; the relay does (every 5 minutes, keeping the last positive result through DNS failures for at most 24 h). A row can therefore be `active` here while relays refuse it; the runbook explains how to check through the relay.
