# D-03. Link codes and engine registration API

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-02, C-03 · **Unblocks:** D-04, D-05
- **Status:** todo
- **Spec:** Pairing and identity (First setup); Interfaces (draft) 1; Abuse on our domains (items 3 and 4); Metadata we still see; ADRs: [0006](../../adr/) (Organizations, members and roles from day one)

## Goal

A signed-in user can create a one-time link code for their active organization, and an engine can register its public key with it through `POST /v1/engines/register`, which links the engine to that organization and returns its engine ID, hostname and relay list.

## Context

The link code only ties an engine to an organization (the tenant that owns engines and billing, ADR 0006) for routing and billing; it grants nothing inside the engine. The engine ID is derived from the engine key, so anyone can check that a hostname belongs to a key. That derivation, the base32 encoding and the request and response schemas live in `packages/protocol` (C-01, C-03). Never re-implement them here.

## Scope

- Migration `0003_engines.sql`:
  - `link_codes(code_hash TEXT PK, org_id TEXT NOT NULL, created_by_user_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, engine_id TEXT)`
  - `engines(engine_id TEXT PK, org_id TEXT NOT NULL REFERENCES organizations, public_key TEXT NOT NULL UNIQUE, hostname TEXT NOT NULL UNIQUE, mode TEXT NOT NULL, engine_version TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active','suspended')) DEFAULT 'active', status_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`
- Link code issuance: page `/engines/new` and a POST action, allowed by `Authorizer.can(actor, 'engine.link', { kind: 'org', orgId })` (new action: `owner` only in v0). All strings through i18n. Shows the code once inside the install command, with a 30-minute countdown and a copy button. Only `SHA-256(code)` is stored.
- `POST /v1/engines/register` in the API router, in this order: per-IP rate limit (20 per hour) → body size cap (4 KiB, 413) → strict parse with the C-03 schema (400) → derive `engineId` and `hostname` with protocol functions → atomically consume the link code and insert the engine in one `DB.batch` → 200 with the C-03 response (`engineId`, `hostname = <engineId>.<engineDomain>`, `relays` from config).
- Outcomes and status codes (use C-03's error schema if it defines one; otherwise `{ "error": code }`):
  - unknown, expired or used link code → 401 `invalid-link-code` (one code for all three, so it is not an oracle);
  - key already registered to the same organization → 200 with the existing data (the code is still consumed);
  - key registered to another organization → 409 `engine-exists`;
  - key belongs to a suspended engine → 403 `engine-suspended`;
  - organization over its engine limit or creation policy → 403 `engine-limit`.
- `EngineCreationPolicy` port: `check(orgId, signal) → { kind: 'allowed' } | { kind: 'denied', reason: 'engine-limit' | 'billing-required' | 'rate-limited' }`. Default adapter enforces at most 5 active link codes and 10 link codes per hour per organization, and a configurable engine cap per organization (default 10). I-05 adds the "card on file" rule using D-07's billing state.
- Domain service `registerEngine(deps, request) → RegisterOutcome` in `src/domain/registration/`, with ports `LinkCodeStore`, `EngineStore` (D1 adapters plus in-memory fakes). Org-facing store methods take `orgId` first and scope every query by it; the registration path is the one place that resolves the org from the link code.

## Out of scope

- Registry lookup for relays (D-04), heartbeats and status (D-05), the engine list (D-06).
- The engine side of registration (M-06 in the mock engine; the real engine in the public repo).
- Engine removal or transfer between organizations (open point; removal will use the `sensitive` action `engine.remove` from D-02).

## Design notes

- Registration is signed by the engine key (decided 2026-10-19, spec Interface 1): verify it with C-03's `verifyRegistration` before touching the link code, and reject with 401 problem+json on a bad signature. Test: a valid link code with a signature from another key is rejected and the code stays unused.

- Link code: use the format C-03 defines. If C-03 leaves it open: 160 bits from `Random`, Crockford base32 without padding, 32 characters, compared only through its hash.
- Consumption must be atomic: `UPDATE link_codes SET used_at = ?, engine_id = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING org_id`, in the same batch as the engine insert, so a database error does not burn the code and two concurrent registrations cannot both win.
- The install command is rendered from a config template with a `{linkCode}` placeholder. Its real shape comes from the engine team (E-01); use a placeholder until then.
- `mode` is stored as sent (`tunnel`, `direct` or `local`, per C-03); relays are returned regardless, the engine decides.
- Registration responses carry `Cache-Control: no-store`. Log engine ID and outcome kind only; never the link code or its hash.

## Acceptance criteria

- [ ] Unit tests for `registerEngine` with fakes: success links the engine to the code's org; expired code (injected `Clock`, 30 min + 1 s); used code; unknown code; same key twice from the same org; same key from another org; suspended engine; engine cap reached.
- [ ] Org isolation: a user of org B cannot create link codes for org A (403) and `EngineStore` reads for org B never return org A's engines.
- [ ] Workers tests through `SELF.fetch`: success response validates against the C-03 response schema and `engineId` equals the protocol derivation of the posted key; unknown field in the body → 400; malformed public key → 400; 5 KiB body → 413; rate limit → 429; two concurrent registrations with one code → exactly one 200; link code row holds only a hash (assert no column contains the plaintext code).
- [ ] Link code page: signed-out access redirects to `/signin`; the plaintext code is not retrievable after the page is left.
- [ ] Schema allowlist updated.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Engine transfer, re-linking after a reinstall with the same key to another organization, and engine removal are not specified.
- Whether an unverified email may create link codes no longer arises: D-02's email-first signup verifies every address.
- Final install command format depends on E-01 and the engine team.
