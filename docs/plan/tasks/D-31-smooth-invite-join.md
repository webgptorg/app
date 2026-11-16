# D-31. Join from an invite in one step and continue into the engine

- **Lane:** Dashboard · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-13, D-14
- **Status:** done (#304)
- **Spec:** [Teams](../../spec/teams.md) "Adding a person"; [ADR 0018](../../adr/0018-teams-and-member-access.md)

## Goal

A colleague who gets an invitation is on the engine's waiting page within a minute, without knowing what a passkey or a dashboard is. Seb's decisions of 2026-11-16.

## Problems this fixes

1. A new person opening an invite saw "Sign in" as the primary action, but had no passkey.
2. Sign-up sent a confirmation email that opened in a new tab, which lost the invite token held in the first tab's memory.
3. After accepting, getting into the engine took several manual steps.

## Decisions

1. **One-step join.**
   - When the invite's email has no account, the invite page says "Join {org}", with the invited email and engines, and one primary button. It creates the account and its passkey on that page and accepts the invite in the same server transaction.
   - The invite link proves the email: it was emailed to that address, works once and lapses after 7 days. So this path sends no separate confirmation email.
   - An existing account gets "Sign in and join": the passkey sign-in happens on the invite page and accepts the invite in the same request.
   - The token survives a reload or a new tab: the SPA keeps it in memory from the fragment, and the server keeps it in a `__Host-` cookie for an hour, HttpOnly and SameSite=Strict, cleared once used. It is never logged.
   - The preview says whether the email already has an account. Only the invite holder learns it, which is acceptable.
2. **Everyone has a dashboard account.** No engine-only members.
3. **Continue into the engine.**
   - After joining, if the invite's engines are exactly one, the page explains the next step in one line, then goes on to that engine's access-ticket flow (`/auth/join#ticket`).
   - With several, the page lists them, each with an "Open" button.
4. **"Invite to this engine"** on the team and engine pages opens the invite dialog with that engine's team selected.
5. **Notifications** carry only names, the engine hostname and links:
   - "{person} is waiting for access to {engine}" to the inviter and the org owners and admins in the team, linking to `https://{engine host}/members`. The dashboard never learns the engine's access-request ID (heartbeat v2 carries only a count), so the link can't name the request.
   - "You're in: open {engine}" to the person once the heartbeat acks the ticket `approved`, linking to the engine.
   - Copy in English and Czech (formal "Vy").

## Acceptance criteria

- [x] Typed routes with strict input, `public` auth and IP rate limits for the join and sign-in-and-join ceremonies.
- [x] Tests for a reused or expired invite, an email mismatch, an invite for an existing account on the new-account path, and rate limits.
- [x] Component tests for the invite page states; e2e teams flow updated.
- [x] `bun run check` passes for the dashboard.
- [x] **Status** line above set to `done (#<PR>)`.
