# D-02. Accounts, passkeys, sessions

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-01
- **Status:** done (#7)
- **Spec:** Pairing and identity (Promptbook account row); Engine security baseline (Sessions row); Security hardening item 8; Metadata we still see; Hosting and stack (Passkeys); ADRs: [0006](../../adr/0006-organizations-and-roles.md), [0007](../../adr/0007-frontend-stack.md), [0009](../../adr/0009-drizzle-and-migrations.md), [0014](../../adr/0014-cryptography.md)

## Goal

People sign up and sign in to app.ptbk.io with passkeys only, get a personal organization with an `owner` membership, hold a server-side session (user plus active org), can recover access through an email link plus a new passkey under strict conditions, and an `EmailSender` port with a Cloudflare Email Service adapter exists.

## Context

The dashboard account grants nothing inside an engine; engine passkeys live on the engine and engine recovery is `engine owner --reset`, unrelated to this account. So the worst case of a dashboard takeover is metadata, billing and availability; the 72-hour cooldown after recovery limits even that. There are no passwords anywhere. D-05 reuses `EmailSender` for offline alerts; D-07, D-08 and I-05 reuse the platform admin role and step-up.

This task is the API and the server side only, so the dashboard lane does not wait for the shared design system; the screens are D-09. Email-first signup, the `SameSite=Lax` session cookie with Fetch Metadata CSRF checks, and the platform admin role were confirmed by the user on 2026-10-19.

## Scope

- Dependencies (exact): `@simplewebauthn/server@14.0.3` and `@simplewebauthn/browser@14.0.0`.
- Tables in `src/adapters/db/schema.ts` (drizzle-kit generates the migration on top of D-01's `organizations`, `users`, `memberships`):

  ```ts
  // added to D-01's users table; random, never the email
  webauthnUserId: blob('webauthn_user_id', { mode: 'buffer' }).unique(),

  export const passkeys = sqliteTable(
    'passkeys',
    {
      credentialId: text('credential_id').primaryKey(),
      userId: text('user_id').notNull(),
      publicKey: blob('public_key', { mode: 'buffer' }).notNull(),
      counter: integer('counter').notNull(),
      transports: text('transports'),
      backedUp: integer('backed_up', { mode: 'boolean' }).notNull(),
      addedVia: text('added_via', { enum: ['signup', 'account', 'recovery'] }).notNull(),
      createdAt: integer('created_at').notNull(),
      lastUsedAt: integer('last_used_at'),
      // set on a signature counter regression; see Design notes
      counterRegressedAt: integer('counter_regressed_at'),
    },
    (t) => [check('passkeys_added_via_check', sql`${t.addedVia} in ('signup', 'account', 'recovery')`)],
  );

  export const sessions = sqliteTable('sessions', {
    idHash: text('id_hash').primaryKey(),
    userId: text('user_id').notNull(),
    activeOrgId: text('active_org_id').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    steppedUpAt: integer('stepped_up_at'),
    revokedAt: integer('revoked_at'),
  });

  export const emailTokens = sqliteTable(
    'email_tokens',
    {
      tokenHash: text('token_hash').primaryKey(),
      purpose: text('purpose', { enum: ['signup', 'recovery'] }).notNull(),
      email: text('email').notNull(),
      userId: text('user_id'),
      createdAt: integer('created_at').notNull(),
      expiresAt: integer('expires_at').notNull(),
      usedAt: integer('used_at'),
    },
    (t) => [check('email_tokens_purpose_check', sql`${t.purpose} in ('signup', 'recovery')`)],
  );

  export const webauthnChallenges = sqliteTable('webauthn_challenges', {
    id: text('id').primaryKey(),
    challenge: text('challenge').notNull(),
    purpose: text('purpose').notNull(),
    userId: text('user_id'),
    tokenHash: text('token_hash'),
    expiresAt: integer('expires_at').notNull(),
  });

  // insert only: the repository exposes no update or delete
  export const adminAuditLog = sqliteTable('admin_audit_log', {
    id: text('id').primaryKey(),
    adminUserId: text('admin_user_id').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    reason: text('reason'),
    createdAt: integer('created_at').notNull(),
  });
  ```

- `EmailSender` port: `send(message, signal)` where `message` is a typed union of templates (`signup-link`, `account-exists`, `recovery-link`, `recovery-notice`; D-05 adds `engine-offline`), each with `to` and `locale`. Templates in English and Czech through D-01's i18n. Adapters: Cloudflare Email Service (`send_email` binding, from address in config) and an in-memory fake that records messages. With `adapters.email = 'fake'` (dev only, enforced by D-01's config schema), `GET /api/__dev/emails?to=<address>` returns the recorded messages so X-05 can follow signup and recovery links in e2e; the route is not mounted in any other configuration.
- Every `/api/*` endpoint below is declared in D-01's `src/shared/api/` route table and called from the SPA through the typed client.
- Email-first signup, so signup and recovery leak nothing about which emails exist: `POST /api/auth/signup/start { email }` always answers 202 with the same body. New email → `signup-link` email; existing user → `account-exists` email with sign-in and recovery links. The link `/signup#<token>` keeps the token out of logs and referrers (the SPA reads the fragment). `signup/options { token }` and `signup/verify { token, response }` create, in one D1 batch (`db.batch([...])`): user (email verified), personal org, `owner` membership, passkey, session.
- Sign-in: `signin/options` (discoverable credentials, usernameless) and `signin/verify`.
- Session: `GET /api/session` → current user (id, email, locale), active org, its role-derived permission list for capability rendering (ADR 0006), and memberships; 401 without a valid session. The SPA's route guards use it.
- Passkeys: `passkeys/options`, `passkeys/verify`, `passkeys/delete` (never the last one); `step-up/options`, `step-up/verify`; `signout`; `sessions/revoke-all`.
- Recovery: `POST /api/auth/recovery/request { email }`; `recovery/options { token }` and `recovery/verify { token, response }`. On success: add the passkey (`added_via = 'recovery'`), revoke every other session, set `users.recovered_at`, start a session, send `recovery-notice` (time, cooldown end, what to do if it was not you), show `/account` with all passkeys so old ones can be removed.
- Authorizer actions added: `passkey.manage`, `session.manage`, and, flagged `sensitive` so the 72-hour cooldown already covers them when later tasks build the routes: `engine.remove`, `engine.hostnames.manage`, `billing.owner.change`. Actor gains `steppedUpAt`; a policy flag `requiresStepUp` (5 minutes) for platform admin actions.
- CSRF middleware for every state-changing `/api/*` request: 403 when `Sec-Fetch-Site` is present and not `same-origin`; when absent, `Origin` must equal `dashboardOrigin`. Machine routes (`/v1`, `/internal`, `/webhooks`) never read cookies and are exempt.
- `RateLimiter` port (Workers Rate Limiting binding adapter, in-memory fake). Defaults: `signup/start` and `recovery/request` 10 per hour per IP and 3 per hour per email hash; `signin/options` 30 per minute per IP; every `verify` 30 per minute per IP. Over limit → 429 (for the two email endpoints the per-email limit is silent: still 202, no email sent).
  - Hourly limits use a Durable Object limiter (decided 2026-10-19, Seb); the Workers binding only supports 10 s/60 s periods. The DO is named by `HMAC-SHA-256(secret, rule ‖ IP-or-email)` with the secret from config, keeps its counter only for the 1-hour window, and fails closed.
- `scripts/make-admin.md`: the `wrangler d1 execute` command that sets `platform_role = 'admin'`. No UI grants it.

## Out of scope

- Screens (D-09). Engines (D-03), billing (D-07), invites and team orgs (later), account deletion (open point).

## Design notes

- Every route is declared through the app's typed `defineRoute` helper and covered by the route-table test ([engineering.md](../../engineering.md#request-handling-every-http-endpoint)): strict input schemas, explicit `auth`, a permission for session routes, a rate limit for anonymous and machine routes. If the helper does not exist yet in this app, create it first in this task.

- WebAuthn: `rpID` is the hostname of `dashboardOrigin` and the expected origin is `dashboardOrigin`, both from D-01's config, never hard-coded (`app.ptbk.io` in production, the dev hostname such as `app.ptbk.test` in the dev container and e2e); `residentKey: 'required'`, `userVerification: 'required'`, `attestationType: 'none'`, algorithms `[-8, -7, -257]`. Challenges single-use, 5-minute TTL, bound by a `__Host-ptbk_chal` cookie and, for token flows, to the token hash.
- WebAuthn hardening (ADR 0014): every `verify` first consumes the challenge atomically (`delete … where id = ? and expires_at > ? returning`), so a failed or concurrent verify can never reuse it; verification always passes `requireUserVerification: true`. Usernameless sign-in looks up the credential, then requires `response.userHandle` to equal its owner's `webauthnUserId` (401 otherwise). Store `newCounter` on success; when the new counter is not greater than a non-zero stored one, set `counter_regressed_at` and log `auth.passkey-counter-regression` (credential owner's user ID only) for I-04 to alert on. Counters of 0 (synced passkeys) are never flagged.
- Email tokens: 256 bits from `Random`, base64url, only SHA-256 stored, 15-minute TTL, consumed atomically with one Drizzle `update ... where used_at is null and expires_at > ? returning`; a new request invalidates the user's older tokens of the same purpose. Emails are sent with `ctx.waitUntil` so response time does not depend on whether the address exists.
- Session cookie `__Host-ptbk_session`: `Secure`, `HttpOnly`, `Path=/`, `SameSite=Lax`. Lax because links from alert emails and the engine UI's "back to dashboard" link must arrive signed in; CSRF is covered by Fetch Metadata and Origin. 256-bit ID, SHA-256 stored, new ID on every sign-in, idle 7 days, absolute 30 days, row read on every request.
- Never log emails, tokens, credential IDs, challenges or cookies.

## Acceptance criteria

- [ ] Signup creates exactly one user, one `personal` org and one `owner` membership; the session's `active_org_id` is that org.
- [ ] Workers tests (software authenticator or SimpleWebAuthn fixtures): signup and signin round trips; replayed, expired, wrong-purpose challenges rejected; wrong origin and rpID rejected; an assertion without user verification rejected; a second verify with an already consumed challenge rejected even after the first failed; usernameless sign-in with a `userHandle` that is not the credential owner's `webauthnUserId` → 401; a counter regression from a non-zero counter sets `counter_regressed_at` and logs the event, while counter 0 does not; cross-site POST and foreign `Origin` → 403; revoked session fails on the next request; last passkey cannot be deleted; rate limits → 429.
- [ ] Recovery, each as a test: the token is 256-bit random, stored only hashed, single-use, rejected after 15 minutes; `recovery/request` returns byte-identical responses for existing and unknown emails; per-email and per-IP limits apply; the token authorizes only `recovery/options` and `recovery/verify` (any other endpoint with it fails, and no session exists before the passkey is registered); after recovery all earlier sessions are revoked, a `recovery-notice` email is sent, old passkeys are listed and removable; `engine.remove`, `engine.hostnames.manage` and `billing.owner.change` are denied with `recovery-cooldown` for 72 hours.
- [ ] `GET /api/session` without a session → 401.
- [ ] `/api/__dev/emails` returns 404 when the email adapter is not `fake`, and the config cannot select `fake` outside dev (test).
- [ ] `EmailSender` port suite runs against the fake; the Cloudflare adapter is unit-tested against a stub binding; templates exist in `en` and `cs`.
- [ ] Session cookie attributes asserted; the migration is drizzle-kit output and passes D-01's drift and destructive guards; schema allowlist updated.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Recovery makes email ownership equal to account ownership after 72 hours. That is accepted because the account reaches no engine data; restate it in the public security document.
- Cloudflare Email Service availability and sending-domain setup (SPF, DKIM, DMARC records via I-02) for staging and production.
- Account deletion for GDPR erasure requests has no task yet; propose one.
- Drizzle's `blob({ mode: 'buffer' })` returns a `Buffer`; convert to `Uint8Array` at the adapter edge and cover a byte round trip on D1 in the adapter test.
