# U-15. Engine UI: access requests and dashboard removals

- **Lane:** Engine UI · **Module:** `apps/engine-ui` · **Milestone:** M3
- **Depends on:** C-13
- **Status:** todo
- **Spec:** [Teams](../../spec/teams.md) "Engine UI"

## Goal

Engine admins approve or decline access requests with the person's code. Owners decide whether the organization may remove members from the dashboard.

## Scope

- **Members:** the Access requests section and a navigation badge.
  - The approve dialog has the code, the role and step-up; decline is one action.
  - Members who came from the dashboard show "via organization".
- **Settings → Security:** the dashboard removals switch, behind step-up.
- Everything renders by permission, never by role name.

## Acceptance criteria

- [ ] Tests for approve, a wrong code, decline and step-up, and for the switch.
- [ ] Axe checks pass and CSP is unchanged.
- [ ] Copy in English and Czech.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.
