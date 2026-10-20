# D-09. Dashboard sign-up, sign-in, recovery and account screens

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-02, U-02
- **Status:** in progress (feat/d-09-auth-account-screens)
- **Spec:** Pairing and identity (Promptbook account row); ADRs: [0006](../../adr/0006-organizations-and-roles.md), [0007](../../adr/0007-frontend-stack.md)

## Goal

The SPA screens for D-02's API: a person can sign up, sign in, recover access and manage passkeys and sessions in the browser, in English and Czech, with the UX bar from ADR 0007.

## Context

D-02 delivers the API and server side without waiting for the design system. This task wires `@ptbk/ui` into the dashboard SPA (Tailwind 4 `@source` for the package, its tokens and shell) and builds the first real screens, so later dashboard screens (D-03's `/engines/new`, D-06, D-07, D-08) reuse the same shell and patterns.

## Scope

- Dashboard app shell from `@ptbk/ui`: header with org name, user menu (language, theme, sign out), navigation shown by capability from `GET /api/session`'s permission list, skip-to-content link, route-level error boundary, pending and not-found components.
- Routes, all strings through Paraglide (en, cs), forms through `@ptbk/ui`'s form layer:
  - `/signup`: email step (`signup/start`, same confirmation for every email), then `/signup#<token>` reads the fragment, runs `signup/options` and `signup/verify` with `@simplewebauthn/browser`, and lands in the app.
  - `/signin`: usernameless passkey sign-in.
  - `/recover`: email step, then `/recover#<token>` registers a new passkey; afterwards it shows the cooldown notice and links to `/account`.
  - `/account`: email; passkeys (name, origin, created, last used, how added) and sessions, each in a `DataTable`; remove passkey (never the last one), sign out everywhere; step-up dialog when the API asks for it.
  - `/admin`: empty shell for platform admins only (filled by D-07, D-08, I-05).
- Route guards from `GET /api/session`: signed-out access to protected routes redirects to `/signin` with `returnTo`; signed-in access to `/signin` and `/signup` redirects home.
- WebAuthn errors (cancelled, not allowed, no passkey on this device) mapped to clear, translated messages with a retry.

## Out of scope

- Server logic, rate limits, emails (D-02). Engine list (D-06), billing page (D-07), admin features (D-07, D-08, I-05).

## Design notes

- Tokens from URL fragments are read once, removed from the address bar with `history.replaceState`, and never stored.
- All data through TanStack Query with the dashboard's typed client (D-01); mutations follow the shared optimistic/rollback and toast conventions where safe (not for passkey removal or sign-out everywhere).
- Screens never reveal whether an email has an account.

## Acceptance criteria

- [ ] Playwright with a virtual WebAuthn authenticator: sign up via the fake outbox link, sign out, sign in, add a second passkey, remove the first, recover via email and land on `/account` with the cooldown notice.
- [ ] Signed-out visit to `/account` redirects to `/signin` and returns after sign-in.
- [ ] axe reports no violations on every screen; works at 360 px; keyboard-only flow completes sign-up and sign-in.
- [ ] Every string exists in `en` and `cs` (catalogue key test).
- [ ] The SPA's CSP (D-01) reports no violations during the flows.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Browsers differ in WebAuthn error reporting; keep the mapping table in one place and test the common ones.
