# D-02. Accounts, passkeys, sessions

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-01 · **Unblocks:** D-03, D-07
- **Status:** todo
- **Spec:** Pairing and identity (Promptbook account row); Engine security baseline (Sessions row); Security hardening item 8; Metadata we still see; Hosting and stack (Passkeys); ADRs: [0006](../../adr/) (Organizations, members and roles from day one)

## Goal

People sign up and sign in to app.ptbk.io with passkeys only, get a personal organization with an `owner` membership, hold a server-side session (user plus active org), can recover access through an email link plus a new passkey under strict conditions, and an `EmailSender` port with a Cloudflare Email Service adapter exists.

## Context

The dashboard account grants nothing inside an engine; engine passkeys live on the engine and engine recovery is `engine owner --reset`, unrelated to this account. So the worst case of a dashboard takeover is metadata, billing and availability; the 72-hour cooldown after recovery limits even that. There are no passwords anywhere. D-05 reuses `EmailSender` for offline alerts; D-07, D-08 and I-05 reuse the platform admin role and step-up.

## Scope

- Dependencies: `@simplewebauthn/server` 14 and `@simplewebauthn/browser` 14, exact versions.
- Migration `0002_accounts.sql` (on top of D-01's `organizations`, `users`, `memberships`):
  - `passkeys(credential_id TEXT PK, user_id TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT, backed_up INTEGER NOT NULL, added_via TEXT NOT NULL CHECK (added_via IN ('signup','account','recovery')), created_at INTEGER NOT NULL, last_used_at INTEGER)`; `users.webauthn_user_id BLOB UNIQUE` (random, never the email).
  - `sessions(id_hash TEXT PK, user_id TEXT NOT NULL, active_org_id TEXT NOT NULL, created_at, last_seen_at, expires_at, stepped_up_at INTEGER, revoked_at INTEGER)`
  - `email_tokens(token_hash TEXT PK, purpose TEXT NOT NULL CHECK (purpose IN ('signup','recovery')), email TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER)`
  - `webauthn_challenges(id TEXT PK, challenge TEXT NOT NULL, purpose TEXT NOT NULL, user_id TEXT, token_hash TEXT, expires_at INTEGER NOT NULL)`
  - `admin_audit_log(id TEXT PK, admin_user_id, action, target_type, target_id, reason, created_at)`; insert only.
- `EmailSender` port: `send(message, signal)` where `message` is a typed union of templates (`signup-link`, `account-exists`, `recovery-link`, `recovery-notice`; D-05 adds `engine-offline`), each with `to` and `locale`. Templates in English and Czech through D-01's i18n. Adapters: Cloudflare Email Service (`send_email` binding, from address in config) and an in-memory fake that records messages. With `adapters.email = 'fake'` (dev only, enforced by D-01's config schema), `GET /__dev/emails?to=<address>` returns the recorded messages so X-05 can follow signup and recovery links in e2e; the route does not exist in any other configuration.
- Email-first signup, so signup and recovery leak nothing about which emails exist: `POST /auth/signup/start { email }` always answers 202 with the same body. New email → `signup-link` email; existing user → `account-exists` email with sign-in and recovery links. The link `/signup#<token>` keeps the token out of logs and referrers. `signup/options { token }` and `signup/verify { token, response }` create, in one `DB.batch`: user (email verified), personal org, `owner` membership, passkey, session.
- Sign-in: `signin/options` (discoverable credentials, usernameless) and `signin/verify`.
- Passkeys: `passkeys/options`, `passkeys/verify`, `passkeys/delete` (never the last one); `step-up/options`, `step-up/verify`; `signout`; `sessions/revoke-all`.
- Recovery: `POST /auth/recovery/request { email }`; `recovery/options { token }` and `recovery/verify { token, response }`. On success: add the passkey (`added_via = 'recovery'`), revoke every other session, set `users.recovered_at`, start a session, send `recovery-notice` (time, cooldown end, what to do if it was not you), show `/account` with all passkeys so old ones can be removed.
- Authorizer actions added: `passkey.manage`, `session.manage`, and, flagged `sensitive` so the 72-hour cooldown already covers them when later tasks build the routes: `engine.remove`, `engine.hostnames.manage`, `billing.owner.change`. Actor gains `steppedUpAt`; a policy flag `requiresStepUp` (5 minutes) for platform admin actions.
- Pages (all strings through i18n): `/signup`, `/signin`, `/recover`, `/account` (email, passkeys with origin and dates, sessions, sign out everywhere), `/admin` shell for platform admins.
- CSRF middleware for every non-machine state-changing request: 403 when `Sec-Fetch-Site` is present and not `same-origin`; when absent, `Origin` must equal `dashboardOrigin`. Machine routes never read cookies and are exempt.
- `RateLimiter` port (Workers Rate Limiting binding adapter, in-memory fake). Defaults: `signup/start` and `recovery/request` 10 per hour per IP and 3 per hour per email hash; `signin/options` 30 per minute per IP; every `verify` 30 per minute per IP. Over limit → 429 (for the two email endpoints the per-email limit is silent: still 202, no email sent).
- `scripts/make-admin.md`: the `wrangler d1 execute` command that sets `platform_role = 'admin'`. No UI grants it.

## Out of scope

- Engines (D-03), billing (D-07), invites and team orgs (later), account deletion (open point).

## Design notes

- WebAuthn: `rpID` and origin from config (`app.ptbk.io` in production, `localhost` in dev); `residentKey: 'required'`, `userVerification: 'required'`, `attestationType: 'none'`, algorithms `[-8, -7, -257]`. Challenges single-use, 5-minute TTL, bound by a `__Host-ptbk_chal` cookie and, for token flows, to the token hash.
- Email tokens: 256 bits from `Random`, base64url, only SHA-256 stored, 15-minute TTL, consumed atomically (`UPDATE ... WHERE used_at IS NULL AND expires_at > ? RETURNING`); a new request invalidates the user's older tokens of the same purpose. Emails are sent with `ctx.waitUntil` so response time does not depend on whether the address exists.
- Session cookie `__Host-ptbk_session`: `Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`. Lax because links from alert emails and the engine UI's "back to dashboard" link must arrive signed in; CSRF is covered by Fetch Metadata and Origin. 256-bit ID, SHA-256 stored, new ID on every sign-in, idle 7 days, absolute 30 days, row read on every request.
- Never log emails, tokens, credential IDs, challenges or cookies.

## Acceptance criteria

- [ ] Signup creates exactly one user, one `personal` org and one `owner` membership; the session's `active_org_id` is that org.
- [ ] Workers tests (software authenticator or SimpleWebAuthn fixtures): signup and signin round trips; replayed, expired, wrong-purpose challenges rejected; wrong origin and rpID rejected; cross-site POST and foreign `Origin` → 403; revoked session fails on the next request; last passkey cannot be deleted; rate limits → 429.
- [ ] Recovery, each as a test: the token is 256-bit random, stored only hashed, single-use, rejected after 15 minutes; `recovery/request` returns byte-identical responses for existing and unknown emails; per-email and per-IP limits apply; the token authorizes only `recovery/options` and `recovery/verify` (any other endpoint with it fails, and no session exists before the passkey is registered); after recovery all earlier sessions are revoked, a `recovery-notice` email is sent, old passkeys are listed and removable; `engine.remove`, `engine.hostnames.manage` and `billing.owner.change` are denied with `recovery-cooldown` for 72 hours.
- [ ] `/__dev/emails` returns 404 when the email adapter is not `fake`, and the config cannot select `fake` outside dev (test).
- [ ] `EmailSender` port suite runs against the fake; the Cloudflare adapter is unit-tested against a stub binding; templates exist in `en` and `cs`.
- [ ] Session cookie attributes asserted; schema allowlist updated.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Recovery makes email ownership equal to account ownership after 72 hours. That is accepted because the account reaches no engine data; restate it in the public security document.
- Cloudflare Email Service availability and sending-domain setup (SPF, DKIM, DMARC records via I-02) for staging and production.
- Account deletion for GDPR erasure requests has no task yet; propose one.
- `SameSite=Lax` deviates from the engine's `Strict`; confirm with a maintainer in review.
