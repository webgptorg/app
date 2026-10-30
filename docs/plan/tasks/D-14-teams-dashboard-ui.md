# D-14. Dashboard teams screens

- **Lane:** Dashboard · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** D-13
- **Status:** todo
- **Spec:** [Teams](../../spec/teams.md) "Dashboard UI"; design: [ui.md](../../design/ui.md)

## Goal

People manage teams and members in the dashboard.

## Scope

- **Teams** replaces Engines in the navigation; "New team" leads into the link flow.
- **The team page:** people with their state and a ⋯ menu, "Invite people", and the engine details.
- **Organization → People:** members, roles, pending invites.
- **The invite dialog** and the accept-invitation page.
- **Open** goes through the access ticket.

## Acceptance criteria

- [ ] Component tests for each person state and each role's view.
- [ ] Screenshots, light, dark and phone, checked before merge.
- [ ] Copy in English and Czech.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.
