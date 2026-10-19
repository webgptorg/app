# U-07. Audit log view

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** U-02 · **Unblocks:** — (X-04 covers it in e2e, see Risks)
- **Status:** todo
- **Spec:** Engine security baseline (Audit: append-only, hash-chained, visible in the security panel), Enterprise-ready engine architecture (Audit), Residual risks (update policy changes are logged); ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md)

## Goal

The owner can page through the engine's audit log, filter it, inspect any entry including its hash-chain links, and see whether the engine reports the chain as intact.

## Context

The engine writes an append-only, hash-chained entry for every authenticated action (sign-ins, agent changes, secret changes, policy changes, passkey revocations). This view is read-only; nothing in the UI can alter or delete entries. Entries are produced by the engine and can contain user content such as agent names, so they render as text only. Access is by capability (`audit.read`), never by role name.

## Scope

- Route `/audit` with `requirePermission('audit.read')`. Search params validated with zod: `from`, `to` (ISO dates), `actor` (member ID), `action` (one or more action types), `target` (resource ID, e.g. an agent), `outcome` (`success | denied | error`), `cursor`.
- Filter bar (`@ptbk/ui` `Field` controls bound directly to the search params, not to local form state): date range (two date inputs with the browser's time zone shown), actor select (from the members list), action multi-select (values from the API's action catalogue, labels translated with a fallback to the raw value), target text input, outcome select, "Clear filters".
- Table: `DataTable` from `@ptbk/ui` in server-side mode, filters and cursor bound to the search params above. Columns: time (absolute, with `RelativeTime` on hover), actor (display name, falls back to ID), action, target, outcome badge, client IP, device or passkey name; IP and device hidden by default below 1024 px through column visibility, card layout below 768 px. Newest first. Cursor paging with previous/next and a page size of 50; focusing or hovering "Next" prefetches the next page. No row selection.
- Row expansion through `DataTable`'s expansion (button with `aria-expanded`): details object as pretty-printed JSON text, entry sequence number, entry hash and previous-entry hash as `CodeText` with copy.
- Chain status `Banner` at the top: the engine's latest verification result (`intact` with time checked, or `broken` with the first bad sequence number, as a danger banner).
- Manual "Refresh" button; no auto-refresh, so the page does not shift under the reader.
- States: skeleton rows, empty (no entries yet), no results for the filters (with "Clear filters"), error state with retry; the route error boundary catches the rest (U-02).
- Hooks in `src/features/audit/`: `useAuditLog(filters)`, `useAuditChainStatus()`, `auditKeys` and `queryOptions` helpers shared with the route loader.

## Out of scope

- Export to CSV or SIEM (later, engine-side per the spec).
- Verifying the hash chain in the browser (see Risks).
- Any write action on audit entries (there are none).

## Design notes

- Unknown action types from a newer engine render as their raw string; the action label map is a lookup with fallback, not an exhaustive `switch`.
- Date filters are sent as UTC instants computed from the local dates; the table shows local time and the zone.
- The details JSON is produced with `JSON.stringify(value, null, 2)` from the parsed object and rendered in a `<pre>` as text.

## Acceptance criteria

- [ ] With 230 seeded entries in the in-memory client: paging reaches all of them in order; filters by actor, action, target, outcome and date range narrow results and are written to the URL; reloading restores the view.
- [ ] Combined filters are sent to the client in one request; changing a filter resets the cursor.
- [ ] Invalid search params (bad date, unknown outcome) fall back to defaults with no crash.
- [ ] Expanding a row shows details and both hashes, by keyboard as well as by mouse; copy puts the exact hash on the clipboard.
- [ ] Focusing "Next" prefetches the next page (in-memory client call count), so the following click renders without a skeleton.
- [ ] Chain status `broken` shows the danger banner with the sequence number.
- [ ] An entry whose target name contains `<img src=x onerror=alert(1)>` renders it as literal text.
- [ ] Without `audit.read` the route shows "no access" and the sidebar hides the item.
- [ ] Empty, no-results and error states each have a test; `axe-core` passes; `test:csp` visits `/audit` with zero violations and passes the UX checks (360 px without overflow, layout shift, reduced motion); the route stays within its bundle budget.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- C-04 must define the entry shape, the filter parameters, the action catalogue and the chain-status endpoint; amend the contract first if missing.
- Client-side chain verification would only help against a lying engine, which the UI cannot detect anyway, and a lying UI could fake it; leave it out unless the security review asks for it.
- X-04 does not list U-07 as a dependency, but the M2 milestone includes the audit flow; X-04 should add U-07 to its dependencies.
