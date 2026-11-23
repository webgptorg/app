# U-23. Setup screens that feel like the rest of the app

- **Lane:** U · **Module:** `apps/engine-ui` (and the primary button in `packages/ui`) · **Milestone:** M5
- **Depends on:** U-20
- **Status:** done (pushed to main)
- **Design:** [ui.md](../../design/ui.md) ("Setup"), [onboarding.md](../../design/onboarding.md)

## Goal

Seb ran the real onboarding (engine 0.119.0-132, UI 0.2.4): the steps work, but they feel cramped, and in dark mode it is not clear what to click to go on. Setup gets the spacing, hierarchy and step actions of the app's other screens, and shows where the member is.

## Scope

- A step timeline from the engine's `progress` (step and count only; the contract is unchanged): down the side on wide screens with `aria-current="step"`, "Step x of y" over one segment per step on narrow ones. A step shows the title this visit saw for it, else its number; steps ahead are never named, since the engine's path may branch. A count over 12, or a step past the count, shows only the words.
- Step actions as in the agent wizard: Back (ghost) on the start side, the forward action (a large primary "Continue →", or a confirm's two answers) on the end side. Text answers use the app's own `Input` and `Textarea` instead of the composer with an icon-only send.
- The primary button's wash is deeper in dark mode and carries an ink-blue line in both themes, so the main action reads as one beside a secondary (in `@ptbk/ui`, so the dashboard gets it too).
- Focus moves to the next step's heading after the member's own answer, never on a poll.
- Generous spacing; en and cs copy; still CSP-safe.

## Out of scope

- Contract changes (step names, totals); the gateway pages' own copy of the button tokens.

## Acceptance criteria

- [x] Before and after screenshots, light and dark, wide and narrow.
- [x] Tests for the timeline (current step, seen titles, no names ahead, the words-only fallback) and for focus after an answer.
- [x] Engine-ui lint, typecheck, unit tests and `test:csp` pass; `@ptbk/ui` tests pass.
- [x] **Status** line above set to `done (pushed to main)`.
