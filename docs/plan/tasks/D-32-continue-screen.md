# D-32. Sign in and sign up from one Continue screen

- **Lane:** Dashboard · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-09
- **Status:** done (#305)
- **Spec:** [D-02](D-02-accounts-passkeys.md) email-first signup; design: [onboarding.md](../../design/onboarding.md)

## Goal

Non-technical people should not have to know whether they have an account. One screen takes an email and does the right thing. Seb's decision of 2026-11-16.

## Decisions

- **The screen.** One email field with `autocomplete="username webauthn"`, so a browser that has a passkey for the dashboard offers it in the field's autofill and one tap signs in. One "Continue" button. The copy explains passkeys once: "We use your fingerprint, face or device PIN instead of a password."
- **Continue, without enumeration.** Step 1 was replaced by [D-34](D-34-continue-email-first.md): Continue sends the email straight away.
  1. The client runs a passkey prompt with discoverable credentials (empty `allowCredentials`). If it succeeds, the person is in and gets no email.
  2. Otherwise it calls `signup/start`, which answers 202 with the same body for every address and sends one email after the response: a sign-in and recovery note to an existing account, a link that finishes creating the account to a new address.
  3. Rate limits stay per IP (`signup-start-ip`) and per address (`signup-start-email`).
- **The email comes second, not in parallel**, so signing in with a passkey never mails anyone. The prompt runs in the browser, so whether it worked tells the server nothing it could leak.
- **Redirects.** `/signin` and `/signup` redirect to `/continue`, keeping `returnTo`. `/signup#<token>` still runs the passkey step of an emailed link.
- **Recovery** stays one link away: "Lost your device? Recover by email". The existing-account email links to it rather than carrying a recovery token, because recovery starts a 72-hour cooldown that a second laptop shouldn't trigger.

## Acceptance criteria

- [ ] Tests: an existing account with a passkey, one without a passkey on this device, a new address, identical answers with delivery after the response, and rate limits.
- [ ] Component tests for the screen, the autofill and the redirects; e2e updated.
- [ ] `bun run check` passes for the dashboard.
- [ ] **Status** line above set to `done (#<PR>)`.
