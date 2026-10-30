# D-13. Dashboard teams: data, roles, invites, tickets, revocations

- **Lane:** Dashboard · **Module:** `apps/dashboard` · **Milestone:** M3
- **Depends on:** C-13
- **Status:** done (#PR)
- **Spec:** [Teams](../../spec/teams.md); ADRs: [0006](../../adr/0006-organizations-and-roles.md), [0018](../../adr/0018-teams-and-member-access.md)

## Goal

The dashboard API knows teams, org roles and invites. It issues access tickets, queues revocations and reads heartbeat v2 acks.

## Scope

- **Migration:**
  - add `teams`, `team_members`, `invites` (token hashed) and `member_revocations`;
  - add `engines.teamId` (unique);
  - backfill one team per engine;
  - rename the `organizations.kind` value `team` to `shared`.
- **Roles and policy:**
  - `orgRoleSchema` becomes owner, admin and member, with `DASHBOARD_POLICY` rows per the spec's table;
  - member queries are scoped to the member's own teams.
- **Routes:**
  - teams: create, rename, delete, list;
  - team members: add, remove, leave;
  - invites: create, resend, revoke, accept;
  - org roles: change;
  - `POST /teams/{id}/access-ticket`.
- **The member key:**
  - a Worker secret signs tickets and revocations;
  - its public key goes into the registration response;
  - the link flow binds the new engine to its team.
- **Heartbeat ingest:**
  - accept v2 and apply the acks;
  - reply with pending revocations, resending until acked.
- **Emails:** the invitation, waiting-for-approval and you-have-access emails, in English and Czech.
- **Engine status emails:** they go to the org owners and admins in that team, falling back to the org owners (`alert-recipients.ts`).
- **Docs:** the runbook for moving a team to another organization.

## Out of scope

- The screens (D-14).

## Acceptance criteria

- [ ] Policy tests per role, including that a member can't see other teams' engines.
- [ ] Invites: expired, reused and revoked are each rejected.
- [ ] A ticket is never issued for a team the user isn't in.
- [ ] A revocation is queued on every removal path: team, organization, leave.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.
