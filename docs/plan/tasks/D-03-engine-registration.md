# D-03. Link codes and engine registration API

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-02, C-03, D-09, D-07
- **Status:** in progress (feat/d-03-registration)
- **Spec:** Pairing and identity (First setup); Interfaces (draft) 1; Abuse on our domains (items 3 and 4); Metadata we still see; ADRs: [0006](../../adr/0006-organizations-and-roles.md), [0008](../../adr/0008-hono-for-http-apis.md), [0009](../../adr/0009-drizzle-and-migrations.md), [0014](../../adr/0014-cryptography.md), [0017](../../adr/0017-billing-entitlements.md)

## Goal

A signed-in user can create a one-time link code for their active organization, and an engine can register its public key with it through `POST /v1/engines/register`, which links the engine to that organization and returns its engine ID, hostname and relay list.

## Context

The link code only ties an engine to an organization (the tenant that owns engines and billing, ADR 0006) for routing and billing; it grants nothing inside the engine. The engine ID is derived from the engine key, so anyone can check that a hostname belongs to a key. That derivation, the base32 encoding and the request and response schemas live in `packages/protocol` (C-01, C-03). Never re-implement them here.

## Scope

- Tables in `src/adapters/db/schema.ts` (drizzle-kit generates the migration):

  ```ts
  export const linkCodes = sqliteTable('link_codes', {
    codeHash: text('code_hash').primaryKey(),
    orgId: text('org_id').notNull(),
    createdByUserId: text('created_by_user_id').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    usedAt: integer('used_at'),
    engineId: text('engine_id'),
  });

  export const engines = sqliteTable(
    'engines',
    {
      engineId: text('engine_id').primaryKey(),
      orgId: text('org_id')
        .notNull()
        .references(() => organizations.id),
      publicKey: text('public_key').notNull().unique(),
      hostname: text('hostname').notNull().unique(),
      mode: text('mode', { enum: ['tunnel', 'direct'] }).notNull(),
      engineVersion: text('engine_version').notNull(),
      status: text('status', { enum: ['active', 'suspended'] })
        .notNull()
        .default('active'),
      statusReason: text('status_reason'),
      createdAt: integer('created_at').notNull(),
      updatedAt: integer('updated_at').notNull(),
    },
    (t) => [
      check('engines_status_check', sql`${t.status} in ('active', 'suspended')`),
      check('engines_mode_check', sql`${t.mode} in ('tunnel', 'direct')`),
    ],
  );
  ```

- Link code issuance: SPA route `/engines/new` (built from `@ptbk/ui` in D-09's shell) and `POST /api/engines/link-codes` (contract in `src/shared/api/`), allowed by `Authorizer.can(actor, 'engine.link', { kind: 'org', orgId })` (new action: `owner` only in v0). All strings through i18n. Shows the code once inside the install command, with a 30-minute countdown and a copy button. The code is C-03's `LinkCode`: 128 bits from `Random`, lowercase RFC 4648 base32 without padding. Only `SHA-256(code)` is stored.
- `POST /v1/engines/register` in the Hono `/v1` router, bound to the C-03 contract, in this order: per-IP rate limit (20 per hour) → body size cap (4 KiB, 413) → strict parse with the C-03 schema (400) → verify the engine's signature with C-03's `verifyRegistration` (401 `bad-signature`) → derive `engineId` and `hostname` with protocol functions → look up the engine ID (403 `engine-suspended`, 409 `engine-exists`) → atomically consume the link code and insert the engine (or, on same-org re-registration, update its `engineVersion`, `mode` and `updatedAt`) in one D1 batch (`db.batch([...])`) → 200 with the C-03 response (`engineId`, `hostname = <engineId>.<engineDomain>`, `relays`: the `relayId` hostnames from D-01's `relays` config).
- Outcomes and status codes, as C-03's `ProblemDetails` (RFC 9457 problem+json with `code`, ADR 0008):
  - unknown, expired or used link code → 401 `invalid-link-code` (one code for all three, so it is not an oracle);
  - signature does not verify → 401 `bad-signature`;
  - key belongs to a suspended engine → 403 `engine-suspended`;
  - key whose derived `engineId` already exists in **the link code's organization** and is active → idempotent 200 with the existing engine's data, the code consumed, and the engine row's `engineVersion` and `mode` updated from the signed request (an engine that lost its local registration state but kept its key can re-link with a fresh code; the signature proves the key, the code proves the org's intent); in **another organization** → 409 `engine-exists` (the code stays unused); suspended or owner-revoked → 403 `engine-suspended`. A second key can never claim an existing engine ID, because the ID is the key's hash, so there is no "same ID, different key" case;
  - organization not entitled to create engines → 403 `not-entitled`; at its `engines.max` quota → 403 `engine-limit`; over the link-code rate limits → 429 `rate-limited`. The SPA shows an upgrade path to `/billing` for the first two (ADR 0017).
- `EngineCreationPolicy` port: `check(orgId, signal) → { kind: 'allowed' } | { kind: 'denied', reason: 'not-entitled' | 'engine-limit' | 'rate-limited' }`. It enforces only rate limits itself (at most 5 active link codes and 10 link codes per hour per organization) and delegates the rest to D-07's `Entitlements` port: `entitlements.allows(orgId, 'engines.create')` (else `not-entitled`) and `entitlements.limit(orgId, 'engines.max')` against the org's active engines (else `engine-limit`; `null` is unlimited). It never checks plan names, cards or Stripe state. Checked both when issuing a link code (so the UI shows the upgrade path before the install command) and at registration.
- Domain service `registerEngine(deps, request) → RegisterOutcome` in `src/domain/registration/`, with ports `LinkCodeStore`, `EngineStore` (D1 adapters plus in-memory fakes). Org-facing store methods take `orgId` first and scope every query by it; the registration path is the one place that resolves the org from the link code.

## Out of scope

- Registry lookup for relays (D-04), heartbeats and status (D-05), the engine list (D-06).
- The engine side of registration (M-06 in the mock engine; the real engine in the public repo).
- Engine removal or transfer between organizations (open point; removal will use the `sensitive` action `engine.remove` from D-02).

## Design notes

- Registration is signed by the engine key (decided 2026-10-19, spec Interface 1; encoding per ADR 0014): `verifyRegistration` checks the signature over `signingInput('ptbk-register-v1', v, linkCode, enginePublicKey (raw 32 bytes), engineVersion, mode)` with the protocol's strict Ed25519 verification. Run it before touching the link code, and reject with 401 `bad-signature` on failure. Test: a valid link code with a signature from another key, or with `mode` or `engineVersion` changed after signing, is rejected and the code stays unused.
- Link code: C-03's format only (128-bit, lowercase base32 without padding); never re-implement or widen it. Compared only through its hash.
- Consumption must be atomic: one Drizzle `update(linkCodes).set({ usedAt, engineId }).where(and(eq(linkCodes.codeHash, hash), isNull(linkCodes.usedAt), gt(linkCodes.expiresAt, now))).returning({ orgId: linkCodes.orgId })`, in the same batch as the engine insert, so a database error does not burn the code and two concurrent registrations cannot both win.
- The install command is rendered from a config template with a `{linkCode}` placeholder. Its real shape comes from the engine team (E-01); use a placeholder until then. In dev the template renders `bun run dev:link {linkCode}`, which starts X-06's local mock engine with that code.
- `mode` is stored as sent (`tunnel | direct`, per C-03); relays are returned regardless, the engine decides.
- Registration responses carry `Cache-Control: no-store`. Log engine ID and outcome kind only; never the link code or its hash.

## Acceptance criteria

- [ ] Unit tests for `registerEngine` with fakes: success links the engine to the code's org; expired code (injected `Clock`, 30 min + 1 s); used code; unknown code; same key twice from the same org (idempotent 200, no duplicate row, `engineVersion` and `mode` updated to the second request's values) and from another org (409 `engine-exists`, code unused); owner-revoked engine re-registering (403); suspended engine; with fake `Entitlements`, `engines.create` denied → `not-entitled` and `engines.max` reached → `engine-limit`, each leaving the code unused; link-code rate limits → `rate-limited`.
- [ ] Org isolation: a user of org B cannot create link codes for org A (403) and `EngineStore` reads for org B never return org A's engines.
- [ ] Workers tests through `SELF.fetch`: success response validates against the C-03 response schema and `engineId` equals the protocol derivation of the posted key; unknown field in the body → 400; malformed public key → 400; 5 KiB body → 413; rate limit → 429; two concurrent registrations with one code → exactly one 200; link code row holds only a hash (assert no column contains the plaintext code).
- [ ] Link codes: `POST /api/engines/link-codes` without a session → 401 and the SPA route redirects to `/signin`; no endpoint returns the plaintext code after issuance.
- [ ] Migration is drizzle-kit output and passes D-01's guards; schema allowlist updated.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Engine transfer and engine removal are not specified. Re-registering an existing key is allowed only within the same organization (idempotent, see Scope); it never moves an engine between organizations. An engine recovering from key compromise gets a new identity (new key, ID and hostname) and registers anew after the owner revokes the old one (D-06, ADR 0014).
- Whether an unverified email may create link codes no longer arises: D-02's email-first signup verifies every address.
- Final install command format depends on E-01 and the engine team.
