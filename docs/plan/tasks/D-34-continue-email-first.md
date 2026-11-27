# D-34. Continue sends the email first; passkeys only on request

- **Lane:** Dashboard · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-32
- **Status:** done (#318)
- **Spec:** [D-32](D-32-continue-screen.md); design: [onboarding.md](../../design/onboarding.md)

## Goal

A new person without a passkey should never see a passkey picker. Today Continue opens a modal passkey prompt before it sends the email, so someone new gets the browser's or password manager's "choose a passkey / use a phone" sheet: a dead end for non-technical people. Seb's decision of 2026-11-18: never let a passkey picker reach people who don't have one.

## Decisions

- **Continue always sends the email.** No modal passkey prompt runs before it. `signup/start` keeps answering 202 with the same body for every address, so nothing about the account leaks (D-32).
- **Passkeys this browser has still sign in with one tap** from the email field's autofill (`autocomplete="username webauthn"`, conditional mediation). Someone who picks one there gets no email.
- **"Use a passkey"** is a quiet secondary action under the form that opens the modal picker on purpose, for a passkey on a phone or in a password manager without autofill. A failure shows the existing passkey banner; the email path stays available.
- **The sent screen** loses "Try a passkey again"; "Use a passkey" on the form covers it, and the sent screen is for the email.
- **Copy** reads as "enter your email; if you already have a passkey here, your browser offers it". Calm and short, English and formal Czech.

## Acceptance criteria

- [ ] Component tests: Continue sends the email without calling the modal passkey request; autofill still signs in without mail; "Use a passkey" opens the picker, signs in, and handles cancellation with the email path still there.
- [ ] e2e specs that drove the modal-first Continue use autofill or "Use a passkey" instead.
- [ ] Other modal-first sign-in surfaces listed in the PR.
- [ ] `bun run check` passes for the dashboard.
- [ ] **Status** line above set to `done (#<PR>)`.
