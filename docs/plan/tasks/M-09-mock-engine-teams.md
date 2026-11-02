# M-09. Mock engine: join page, access requests, revocations

- **Lane:** Mock engine · **Module:** `apps/mock-engine` · **Milestone:** M3
- **Depends on:** C-13
- **Status:** done (#187)
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
- **Heartbeat v2** once the member key is pinned. With that, the `member-access` conformance suite (C-13) stops
  skipping and must pass; add it to the platform self-test.
- **Conformance for what needs the join page,** which C-13 left to this task because it needs a browser on the engine's
  origin. Add these checks to `member-access`:
  - tickets: forged, expired, replayed, for the wrong engine, over the pending cap;
  - approve: a wrong code (missing step-up is a mock unit test: the harness's sessions are always fresh);
  - revocations: the last owner, removals switched off.

## Acceptance criteria

- [ ] Tests for every reject path in the spec, and the conformance run green.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.
