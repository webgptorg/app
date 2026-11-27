# U-28. Phone use: the dashboard and engine UI at 360–414 px

- **Lane:** U · **Module:** `packages/ui`, `apps/dashboard`, `apps/engine-ui` · **Milestone:** M5
- **Depends on:** U-17, U-27
- **Status:** in progress (feat/u-28-phone-use)
- **Spec:** —; ADRs: [0015](../../adr/0015-ui-architecture-and-design-system.md), [0016](../../adr/0016-engine-capabilities.md)

## Goal

Phone use is a v1 roadmap item. Customers often open the product on a phone, and it must make sense to people who are not technical. The dashboard and the engine UI work at phone widths (360–414 px) and by touch: nothing scrolls sideways, every menu and action is reachable, tap targets are big enough, dialogs fit the screen, and nothing needs a hover.

## Context

The responsive brief in [ui.md](../../design/ui.md#responsive) says "works from 360 px", and engine-ui's CSP checks already measure overflow at 360 px on load. Nobody had looked at either app on a phone by hand, nor at the dashboard at that width at all.

## Scope

- Audit both apps headless at 375 × 812 and 360 × 740 (dashboard: sign-in, projects, project detail and install, team, billing, account; engine-ui: Home, chat, agents, runs, settings, setup) and list the concrete problems.
- Fix them, shared fixes in `packages/ui` first (navigation, tables, dialogs, touch targets, hover fallbacks), then per-screen fixes where a screen is the problem. Keep the look: no screen redesigns.
- A phone pass in each app's `test:csp` suite that walks the main screens at 375 × 812 and fails on horizontal overflow (`document.scrollingElement.scrollWidth > clientWidth`).

## Out of scope

- The Book editor beyond "usable" (ui.md keeps it desktop-optimised), native apps, offline or push notifications.

## Acceptance criteria

- [ ] Problems found and fixed listed in the PR, with before and after screenshots.
- [ ] Every main screen of both apps fits 375 px with no horizontal overflow (phone specs in `apps/dashboard/test/csp` and `apps/engine-ui/test/csp`).
- [ ] Hovercards and other hover-only affordances have a tap path.
- [ ] engine-ui and dashboard tests, the CSP suites and the bundle budgets pass.
- [ ] **Status** line above set to `done (#<PR>)`.
