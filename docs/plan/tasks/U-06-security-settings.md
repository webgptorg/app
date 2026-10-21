# U-06. Security panel, settings, members, secrets

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M2
- **Depends on:** U-02
- **Status:** done (#41)
- **Spec:** Transparency and verifiability (3 self-checks), What our platform can and cannot do (heartbeat, write-only credentials), Residual risks (update policy, CT), Security hardening (4 outbound list, 7 secrets), Pairing and identity (revoke), Enterprise-ready engine architecture; ADRs: [0003](../../adr/0003-ui-as-signed-bundle.md), [0015](../../adr/0015-ui-architecture-and-design-system.md); design: [ui.md](../../design/ui.md) (Trust mark, Security)

## Goal

The owner can verify the engine's security claims from the UI (engine identity and fingerprint, version and log entries, UI bundle hash, certificate, CT check, relays, hostnames, the exact last heartbeat), set the update policy, see members, manage passkeys, and manage secrets whose values are never shown back.

## Context

The security panel is how a customer checks our claims without trusting us, so it must show the engine's own values verbatim, not reformatted guesses. Per [ui.md](../../design/ui.md), trust should be felt rather than read: the page opens with the Promptbook trust mark and the engine fingerprint, which the dashboard shows for the same engine (D-06), so users can compare them across devices the way Signal users compare safety numbers. Secrets are write-only by design: a stolen session can replace a secret but never read it. v0 has a single owner, but members and roles are modelled from day one; the members screen is read-only and every action is rendered through `can()` (U-02).

## Scope

- `/security` (`requirePermission('security.read')`), sections as `Card`s:
  - **Trust panel** (first, above the fold): the headline "Private engine: your data stays on your server", then engine identity: the `TrustMark` from `@ptbk/ui` (U-02) at large size with its fingerprint pattern and short code, derived from `GET /engine`'s `engineId` (C-07), the full engine ID and default hostname as copyable `CodeText`, and short copy explaining that the same pattern and code appear in the dashboard's engine list (D-06) and that a different fingerprint means a different engine. The seal plays its calm verify animation once when the security data has loaded and the bundle version matches. The shell's `TrustMark` (U-02) links here; this task wires that link.
  - **Engine:** version, release log entry (Rekor log index and entry UUID as copyable text, plus an `ExternalLink` to a public Rekor search), update status (`none | available | pending | installing`) with the pending version and its earliest install time.
  - **Update policy:** `auto | manual | pinned` (with version). Changing it (C-04's `PUT /settings/update-policy`) needs `can('settings.manage')` and a fresh passkey assertion (step-up via `useStepUpAwareMutation`); the panel says the change is logged.
  - **UI bundle:** version, SHA-256 and log entry as reported by the engine's loader. Also show the version compiled into the bundle and a warning banner if the two differ.
  - **Certificate and CT:** SHA-256 fingerprint of the engine's current certificate, with a short instruction to compare it with the browser's certificate viewer; time and result of the last CT check; any foreign certificate found, as a danger banner.
  - **Relays and tunnel:** per relay: hostname, state (`connected | connecting | disconnected`), connected since, last ping round trip. Refresh every 10 s while visible.
  - **Hostnames:** default hostname and custom domains, each with certificate status and, for custom domains, whether the signed claim is registered.
  - **Outbound destinations:** the list the engine reports (spec, hardening item 4).
  - **Last heartbeat:** the exact payload the engine sent, shown as the raw string in a `<pre>` (no parse and re-serialise), with the sent time, the signature header value, and a "copy" button. A collapsible field table below explains each field.
- `/members` (`requirePermission('members.read')`): read-only `DataTable` from `@ptbk/ui` (server-side mode, cursor paging in typed search params, column visibility, card layout below 768 px): display name, role label, number of passkeys, last seen, joined. No invite or role editing in v0 and no row selection; the table's row actions slot leaves room for actions later.
- Passkeys (section on `/security` or `/settings/passkeys`): the current member's passkeys (name, created, last used, authenticator kind), revoke with `ConfirmDialog` and step-up; revoking the passkey of the current session warns that it signs you out. Members with `members.manage` (draft in C-04) see and revoke all members' passkeys.
- `/secrets` (`requirePermission('secrets.read')`): `DataTable` of name, scope (engine-wide or one agent), created, last rotated, last used, state (`active | revoked`), in server-side mode: C-04 pages secrets (`GET /secrets?q&scope&status&cursor&limit`), so search, the scope and state filters and the cursor are typed search params sent to the server, and nothing is filtered or sorted on the client. Actions behind `can('secrets.manage')`: create (name, scope, value), replace value, revoke, delete (typed confirmation). Name and scope use the `@ptbk/ui` form layer with a zod schema. The value uses `SensitiveInput` from `@ptbk/ui`: `type="password"`, `autocomplete="new-password"`, `spellcheck={false}`, without a reveal toggle; it is uncontrolled, never registered with the form store and read once on submit, so the value never enters React state, the form store, the query cache or the URL.
- Mutations (update policy, passkey revoke, all secret actions) wait for the server; none is optimistic, because each is security-relevant and may need step-up. Every outcome is reported with a toast that names the object, never a value.
- `/settings`: language and theme (from U-02), link to passkeys.
- Hooks in `src/features/security/`, `src/features/members/`, `src/features/secrets/` with query-key factories and `queryOptions` helpers shared with the route loaders.
- States: skeletons shaped like each card and table, empty states (no secrets yet, no custom domains, no outbound destinations), error states with retry per section so one failing endpoint does not blank the panel; the route error boundary catches the rest (U-02).

## Out of scope

- Member invites, role editing, one-time device link QR (v1).
- Audit log (U-07). Engine sign-in and step-up pages (engine gateway).
- Verifying Rekor proofs in the browser: the engine does it; the panel shows the result.

## Design notes

- Response schemas come from C-04. Engines are held to the strict schemas; the client reads tolerantly (AGENTS.md rule 5), so a `value` field an engine wrongly sends with secret metadata is dropped before the UI sees it. That is a safety net, not the check: a stolen session would read the API directly, so C-05's `engine-api.secrets.never-returned`, run against every engine, is what proves values are never returned (decided 2026-10-21).
- The heartbeat payload is untrusted text from the UI's point of view: render as text only.
- Fingerprints and hashes use `CodeText` with groups of four characters for readability, and copy the unformatted value.

## Acceptance criteria

- [x] Trust panel: the fingerprint code rendered for the in-memory client's seeded engine ID equals the shared `@ptbk/ui` test vector for that ID; the mark's accessible name contains the code; with `reducedMotion: 'reduce'` the verify animation does not run; activating the shell's trust mark navigates to `/security` and moves focus to the trust panel heading.
- [x] Security panel renders every section from the in-memory client; the heartbeat `<pre>` text equals the raw string byte for byte (test with unusual key order and spacing).
- [x] UI version mismatch shows the warning; a foreign CT certificate shows the danger banner; a relay `disconnected` shows text, not only colour.
- [x] Update policy change: step-up path tested; without `settings.manage` the control is read-only.
- [x] Secrets: create, replace, revoke and delete work; after create and replace, the value is absent from `document.body` (including attributes), from the serialised query cache, from the form store and from any toast; the input is cleared after submit and after a failed submit.
- [x] A secret response carrying a `value` field never exposes it: the tolerant reader drops it before the UI sees it, so it reaches neither the DOM, the query cache nor a toast (test with a fake engine that leaks a canary). C-05 `engine-api.secrets.never-returned` is the authoritative check that engines never return values.
- [x] Members table is read-only: no invite, edit or remove controls exist; with an empty permission list `/members`, `/secrets` and `/security` show "no access".
- [x] Passkey revoke requires confirmation and step-up; revoking the current passkey warns first.
- [x] The members table pages through a `large-fleet`-sized in-memory data set; the secrets table pages through more than one server page; members cursor and secrets filters and cursor are restored from the URL on reload.
- [x] A failing security section shows its own error state with retry while the other sections render; empty states each have a test; each mutation shows a success or failure toast.
- [x] `axe-core` passes on each page; `test:csp` visits each page with zero violations and passes the UX checks (360 px without overflow, layout shift, reduced motion); each route stays within its bundle budget.
- [x] `bun run check` passes.
- [x] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- `engineId` in `GET /engine` arrives with C-07, which this task does not depend on; until it lands the trust panel shows the mark without a fingerprint (and says so), and the fingerprint criterion runs once C-07 is merged.
- Many fields here (log entry IDs, bundle hash from the loader, CT result, relay round trip, outbound list, raw heartbeat, passkeys) must exist in C-04; list missing ones and amend the contract first.
- Revoke versus delete for secrets: assumed revoke keeps metadata for the audit trail and blocks use, delete removes it. Confirm with the engine team.
- A malicious UI could lie in this panel; its value is against everything except the UI itself. The engine CLI should offer the same self-checks (engine team, E-01).
