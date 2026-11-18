# D-33. Leave no dead ends on the way into an invitation

- **Lane:** Dashboard · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-31, D-32
- **Status:** in progress (feat/d-33-invite-no-dead-ends)
- **Spec:** [Teams](../../spec/teams.md) "Adding a person"; [ADR 0018](../../adr/0018-teams-and-member-access.md)

## Goal

Whoever opens an invitation gets in, whatever state their browser is in: signed out, signed in as someone else, or on a device without their passkey. Seb's decisions of 2026-11-18, after testing invites with a new person.

## Problems this fixes

1. Someone who signed in or signed up another way (the Continue screen, a sign-up email, recovery, another device) never saw their invitation again unless they reopened the link.
2. Signed in as another account, the invite page showed a warning banner and one "Sign out" button, with no clear way back.
3. "Sign in and join" opens the browser's passkey picker, which is useless on a device that has no passkey for that account.

## Decisions

1. **Offer pending invitations after any sign-in or sign-up.**
   - When the signed-in account's verified email has a pending, unexpired invitation, the dashboard shows it: "You're invited to {org} by {inviter}" and "Join". Never accepted automatically.
   - It sits at the top of home (the team list, where sign-in and sign-up land) while it is pending, and on the recovery end screen.
   - Accepting needs no token: the account's email is verified and equals the invitation's (case-insensitive, the same normalisation as the token path). Anything else, and an expired, revoked or used invitation, answers `invite-invalid` (404), so invitation IDs can't be probed.
   - Accepting reuses the token path's accept transaction, then continues into the engine like D-31's "You're in".
   - Routes: `GET /api/invites/offers` and `POST /api/invites/offers/:inviteId/accept`, session auth, `invite.accept`, IP rate limits, strict input.
2. **Another account signed in.** The invitation is for one person.
   - "This invitation is for {invited}. You're signed in as {current}."
   - Primary: "Continue as {invited}" signs out here, stays on the page, and shows the next step (create the account, or sign in).
   - Secondary link: "Stay signed in as {current}" goes to the dashboard.
   - The other account can't accept.
3. **Existing account, no passkey on this device.**
   - Under "Sign in and join": "No passkey on this device? Email me a link". It sends the existing recovery email to the invited address (`/api/auth/recovery/request`), then shows "Check your inbox at {email}".
   - Registering a passkey from that link signs the person in, and decision 1 offers the invitation.
   - The failure banner after a cancelled or failed sign-in offers the same link.
   - The invitation token never adds a passkey to an existing account: a forwarded invitation would be an account takeover.
   - The copy says "add a passkey on this device", not recovery.
4. **The new-account path** keeps one button that only registers a passkey, never a sign-in picker.

Copy in English and Czech (formal "Vy").

## Acceptance criteria

- [ ] Server flow tests on memory and D1 for listing and accepting by ID: another address, expired, revoked, already used, another organization's invitation, an unverified address, rate limits.
- [ ] Component tests for the new invite page states and the pending-invitation offer.
- [ ] `bun run check` passes for the dashboard; `test:csp` and the e2e `dashboard` scenario pass.
- [ ] **Status** line above set to `done (#<PR>)`.
