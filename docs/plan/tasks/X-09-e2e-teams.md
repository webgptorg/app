# X-09. E2E: invite, approve, remove

- **Lane:** Cross-cutting · **Module:** `e2e/` · **Milestone:** M3
- **Depends on:** M-09, D-14, U-15
- **Status:** todo
- **Spec:** [Teams](../../spec/teams.md)

## Goal

One browser flow proves the feature through the relay. In order:

1. An org admin invites a person to a team.
2. They accept, open the team, and wait with a code.
3. The engine owner approves with the code.
4. The person uses the engine.
5. The org admin removes them from the dashboard.
6. The person's session ends within one heartbeat.

## Acceptance criteria

- [ ] The flow passes in the e2e stack.
- [ ] The same removal with dashboard removals switched off leaves the person on the engine and shows the "remove them on the engine" state.
- [ ] **Status** line above set to `done (#<PR>)`.
