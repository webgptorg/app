# M-09. Mock engine: join page, access requests, revocations

- **Lane:** Mock engine · **Module:** `apps/mock-engine` · **Milestone:** M3
- **Depends on:** C-13
- **Status:** todo
- **Spec:** [Teams](../../spec/teams.md) "Adding a person", "Removing a person"; ADRs: [0018](../../adr/0018-teams-and-member-access.md)

## Goal

The mock engine implements the teams contracts as the reference for the engine team.

## Scope

- **The member key:** pin it from the registration response.
- **The `/auth/join` gateway page:** it verifies the ticket, registers the passkey, shows the code and waits for approval.
- **Access requests:**
  - the cap, expiry and approve with the code;
  - members get their `dashboardUserId`.
- **Heartbeat v2:** the request count and acks.
- **Applying revocations from the reply:** disable the member, delete their passkeys and sessions, write audit; refuse the last owner and refuse when switched off.
- The conformance suite from C-13 passes against the mock.

## Acceptance criteria

- [ ] Tests for every reject path in the spec, and the conformance run green.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.
