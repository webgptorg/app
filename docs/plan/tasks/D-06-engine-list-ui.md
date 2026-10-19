# D-06. Engine list and status UI

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-05, D-09, D-04
- **Status:** todo
- **Spec:** One address for users; What our platform can and cannot do; Residual risks (3. Our dashboard); Abuse on our domains (Before the Public Suffix List entry lands); ADRs: [0006](../../adr/0006-organizations-and-roles.md), [0007](../../adr/0007-frontend-stack.md), [0014](../../adr/0014-cryptography.md)

## Goal

A signed-in user sees the engines of their active organization with live status from heartbeats, opens any of them at `https://<engineId>.<engine domain>` in a new tab, and an owner can revoke an engine whose key is compromised.

## Context

This is the dashboard's main screen and the M3 demo: sign up, link the mock engine, see it online, open it. The page shows only registry data and heartbeat numbers. It never loads anything from an engine hostname: no fetch, iframe, image, favicon or prefetch (docs/security.md, "Our domains never load engine data"; D-01's CSP `connect-src 'self'; frame-src 'none'` enforces the fetch and frame parts). Passkeys on the engine are bound to its exact hostname, so the hostname must be shown in full and copyable, as the spec relies on users recognising it.

An engine key cannot be rotated in place: the engine ID is the key's hash (ADR 0014). Recovery from a compromised key is a new identity, an owner reset on the engine and a new registration (E-01 documents the engine side). The dashboard's part is "revoke engine", which suspends the old identity so relays stop routing it.

## Scope

- SPA routes built from `@ptbk/ui` components (U-02), all strings through D-01's i18n, English and Czech:
  - `/engines` (also the post-sign-in landing page): a `DataTable` (TanStack Table, virtualized with TanStack Virtual past a page of rows) with one row per engine: status badge, engine ID (shortened with a copy-full button), default hostname and active custom hostnames (read through D-04's `EngineHostnameStore`, only for engines the actor is already authorized to read; empty until D-08 adds rows), last seen (relative, exact on hover), engine version, update state, agents, members, disk and RAM buckets, CPU load.
  - `/engines/$engineId`: the same fields plus the last heartbeat payload as a read-only field list (the spec wants owners able to see exactly what we receive).
  - Empty state: explanation and a button to `/engines/new` (D-03).
- Endpoints `GET /api/engines` and `GET /api/engines/:engineId` in the Hono `/api` router, declared in D-01's `src/shared/api/` route table and called through the typed client: resolve the session's actor, call `Authorizer.can(actor, 'engine.read', resource)` (new action, `owner` in v0), read engines from the org-scoped `EngineStore` with the session's `orgId`, then fetch each engine's `EngineStatus.getStatus()` over RPC in parallel (cap concurrency at 10, 2-second timeout per call; a timeout shows `unknown` for that engine, not an error page).
- Pure domain function `deriveEngineDisplayStatus(engine, snapshot) → 'suspended' | 'never-seen' | 'online' | 'offline' | 'unknown'`; suspended wins over heartbeat state.
- "Open" link: `<a href="https://<hostname>/" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">`. Built from the stored hostname, never from user input.
- Refresh through TanStack Query: refetch on window focus and every 60 seconds while visible (`refetchInterval`, no background refetch).
- "Revoke engine" on `/engines/$engineId`: `POST /api/engines/:engineId/revoke`, Authorizer action `engine.revoke` (new, `owner` only), flagged `sensitive` so D-02's 72-hour recovery cooldown denies it with `recovery-cooldown`, and `requiresStepUp` (D-02's 5-minute step-up; without it the API answers with the step-up error and the SPA runs D-02's step-up flow). It sets `engines.status = 'suspended'` and `status_reason = 'owner-revoked'` through an org-scoped `EngineStore` method; relays close the engine's tunnels at their next registry refresh (D-04, R-03, within `RELAY_REGISTRY_TTL_S`), D-05 rejects its heartbeats and D-03 its re-registration with 403. No undo in the UI. Every revocation inserts a row into a new insert-only `org_audit_log` table (`id`, `org_id`, `actor_user_id`, `action`, `target_type`, `target_id`, `created_at`; same repository rule as D-02's `admin_audit_log`).
- Confirmation dialog (`@ptbk/ui`) before the request: the engine stops being reachable through our relays within minutes; revocation is permanent for this engine ID; recovery means a new engine identity (new key, new engine ID and hostname, owner reset on the engine, a new link code), so bookmarks and the engine's passkeys for the old hostname stop working. The user confirms by typing the engine ID's first 8 characters.
- An org switcher component in the header that lists the user's memberships (one in v0, from D-02's `GET /api/session`) and changes `active_org_id` through `POST /api/session/active-org`, guarded by membership. Kept minimal; it exists so the session model is exercised.

## Out of scope

- Engine names or labels, removal, transfer, un-revoking (open points); custom domain management (D-08, admin only).
- Showing anything from inside the engine; links into engine paths beyond `/`.

## Design notes

- `GET /api/engines/:engineId` for an engine of another organization returns the same 404 as for a missing one.
- Never call the DO for engines the actor may not read; authorization comes before status fetches.
- Accessibility: status is conveyed by text, not colour alone; table is keyboard navigable.
- Components depend on TanStack Query hooks, and the hooks on the typed API client interface, so client tests render with a fake client and fake data.

## Acceptance criteria

- [ ] Unit tests for `deriveEngineDisplayStatus`, covering all five outcomes.
- [ ] Workers tests: a user of org A sees only org A's engines; `GET /api/engines/:engineId` with org B's engine ID → 404; no session → 401; a DO timeout returns `unknown` for that engine and the rest normally. Client tests: signed-out → redirect to `/signin`; an `unknown` engine renders as such without an error page.
- [ ] A rendered "Open" link has `target="_blank"`, `rel="noopener noreferrer"`, `referrerpolicy="no-referrer"` and the exact `https://<engineId>.<engine domain>/` URL.
- [ ] A test asserts the rendered engine pages' DOM contains no reference to the engine domain other than those anchor `href`s (no `src`, `link rel=prefetch|preconnect|dns-prefetch`, no `fetch` target), and that the typed client only targets `/api/*`.
- [ ] Revoke, Workers tests: without a fresh step-up → step-up error and no change; within 72 hours of D-02 recovery → 403 `recovery-cooldown`; a non-owner → 403; org B's engine ID → 404; success sets `suspended` with `owner-revoked`, writes one `org_audit_log` row, and `deriveEngineDisplayStatus` then returns `suspended`. Client test: the dialog shows the recovery explanation and the request is sent only after the typed confirmation.
- [ ] Both locales render the list and detail pages and the revoke dialog without missing keys.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Engine display names: a user-chosen label is account metadata, not engine content, but it is free text we would then store. Decide before adding one; v0 shows engine IDs only.
- Engine removal and transfer flows are unspecified; removal would be the `sensitive` action `engine.remove` with the 72-hour recovery cooldown.
- I-05's admin unsuspend must not silently undo an owner revocation; confirm with I-05 that `owner-revoked` engines are excluded or need the owner.
- Per-request fan-out to Durable Objects is fine for a handful of engines per org; revisit with a D1 summary table if orgs grow large.
