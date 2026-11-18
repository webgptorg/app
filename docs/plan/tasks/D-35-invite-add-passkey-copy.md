# D-35. Speak in invite terms when an invitee adds a passkey

- **Lane:** Dashboard · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-33
- **Status:** in progress (fix/d-35-invite-add-passkey-copy)
- **Spec:** [Teams](../../spec/teams.md) "Adding a person"; [D-33](D-33-invite-no-dead-ends.md) decision 3

## Goal

D-33's "No passkey on this device? Email me a link" sends the account-recovery email. Someone who only wants to join their colleagues then reads "Recover access" and "Register a new passkey". Seb's decision of 2026-11-18 (option A): keep recovery's safety, soften the wording.

## Decisions

1. **The security model does not change.** Same token, lifetime, single use, cooldown, sign-out of every other session and recovery notice.
2. **The request says where it comes from.** `POST /api/auth/recovery/request` takes an optional strict `context: { kind: 'invite' }`. The response stays identical for every address and context.
3. **The org name comes only from the server.** With the invite context, the email names the organization of the newest pending, unexpired invitation to that address: "Add a passkey to join {org}". The body says to open the link on the device to use, add a passkey and join, and states in one calm sentence that other devices get signed out and sensitive actions are on hold for 72 hours. With no such invitation, the normal recovery email goes out.
4. **The page follows the email.** Only the invite email links to `/recover?via=invite#<token>`. The hint changes copy only; the token decides what happens. `/recover` then says "Add a passkey on this device", keeps the safety sentence, and afterwards shows the pending invitation first with "Join". Never accepted automatically.

Copy in English and Czech (formal "Vy").

## Acceptance criteria

- [ ] Server tests: the invite email, the plain recovery email, an invite context for an address with no pending invitation falls back to plain recovery, strict rejection of unknown context fields.
- [ ] Component tests for `/recover` in both modes.
- [ ] The e2e "existing account on a new device" journey follows the new copy and landing.
- [ ] The dashboard's typecheck, lint, tests and `test:csp` pass; the e2e `dashboard` scenario passes.
- [ ] **Status** line above set to `done (#<PR>)`.
