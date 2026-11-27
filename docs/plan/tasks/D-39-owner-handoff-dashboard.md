# D-39. Dashboard: finish owner setup from the pairing tab

- **Lane:** D · **Module:** `apps/dashboard` · **Milestone:** M5
- **Depends on:** C-20, D-36
- **Status:** todo
- **Spec:** Pairing and identity; ADR [0023](../../adr/0023-owner-setup-handoff.md); [onboarding.md](../../design/onboarding.md), step 4

## Goal

After the copied command pairs an engine, the tab that showed it opens the engine's setup page by itself, so an owner on a server never copies a link out of an SSH session. app.ptbk.io only ever sees `SHA-256(S)`.

## Scope

- Both link-code routes take an optional, strictly parsed `ownerSetupCommitment`. A nullable D1 column on link codes (Drizzle migration) holds it; it is nulled when the code is redeemed, cancelled or expires, and handed to the engine once in the registration answer.
- `ownerHandoff` from the heartbeat in the engine view.
- The SPA draws `S` (16 bytes from `crypto.getRandomValues`, base64url) on New project, keeps it only in `sessionStorage` under the link code's ID, and when the code is linked, the engine reachable, `members` = 0 and `ownerHandoff` is `ready`, deletes it and calls `location.assign("https://<hostname>/setup#" + S)`.
- A tab without `S` keeps today's row 5 copy. No new route.
- Docs: the spec's sentence on the setup secret, onboarding.md row 5, engine-first-installation.md, and the AGENT_BRIEF entry for the engine team.

## Acceptance criteria

- [ ] Route tests: the commitment is optional, strict (wrong length, unknown field refused), stored, answered once, and nulled on redeem, cancel and expiry.
- [ ] SPA tests: no redirect without `S`, before `ready`, with members, or when offline; one redirect that deletes `S` first.
- [ ] **Status** line above set to `done (#<PR>)`.
