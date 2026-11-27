# U-24. Onboarding answers that stick, and a way back in after the session ends

- **Lane:** U · **Module:** `apps/engine-ui` · **Milestone:** M5
- **Depends on:** U-20
- **Status:** done (pushed to main)
- **Design:** [ui.md](../../design/ui.md), [gateway.md](../../engine-integration/gateway.md#sessions)

## Goal

Two problems Seb hit with engine-ui 0.2.4 on the real engine: the setup choice step looked "one step behind" and ignored deselecting, and an expired session left the app unusable with no way to sign in again.

## Scope

- Setup: a state read that left before an answer must never land after it and put the answered prompt back. A stale answer (409 `onboarding-prompt-stale`) must read the state again, also on an engine that has nothing but setup.
- Session: a 401 `unauthenticated` from the event stream leads to the sign-in page like any other 401. A page that a 401 left behind offers "Sign in again", which returns to the same page.

## Out of scope

- Engine-side staleness (activity not reset, an aborted harness check writing an old list back): that goes to the engine team.
- A contract for harness sign-in that expires after setup.

## Acceptance

- `answer-order.test.tsx`: a late read does not resurrect the answered choice prompt, the request carries exactly the picked IDs, and a stale answer on a setup-only engine shows where the engine is now.
- `engine-events.test.ts`: the stream reports `unauthenticated`. `app.test.tsx`: the route shows "Sign in again" with `next` set to the current path.
