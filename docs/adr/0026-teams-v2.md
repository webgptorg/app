# 0026. Teams v2: departments with team admins and several projects

- **Status:** Proposed
- **Date:** 2026-11-27
- **Decisions from:** Seb, roadmap interview of 2026-11-27
- **Builds on:** [ADR 0018](0018-teams-and-member-access.md), [teams spec](../spec/teams.md), [ADR 0006](0006-organizations-and-roles.md)

## Open questions for Seb

1. **One approval for all of a team's projects?** Today each project approves each person separately. Can one approval cover every project in the team without breaking "only people on the engine let someone in"? Options and a recommendation are under [Approval across projects](#approval-across-projects).
2. **The team admin's proposed role on the engines:** `admin` (they can then approve their own team's people on the engine) or `member` (an engine admin approves them). This ADR proposes `admin`.

## Context

Companies want departments (Marketing, Sales) that run themselves: someone in the department adds colleagues and links projects without asking the org owner each time. Teams v1 ([ADR 0018](0018-teams-and-member-access.md)) has two limits:

- Only org owners and admins manage teams and people. The teams spec ruled out "an admin of a single team".
- A team holds at most one engine, enforced by the unique `engines.teamId`. ADR 0018 designed this so that several engines per team would be additive: members, invites and requests already hang off the team, and approval and revocation already work per engine.

The engine stays the authority on who uses it. The dashboard must never be able to add a member or a passkey to an engine ([spec](../spec/zero-trust-spec.md#what-our-platform-can-and-cannot-do)).

Naming: screens say **Team** for the department and **Project** for an engine; code and contracts keep `team` and `engine`.

## Decision

1. **Teams are departments of an organization.** Flat, as in v1; a person can be in several.
2. **A team holds several projects.** The unique index on `engines.team_id` is dropped. A team may also have none.
3. **A new team-scoped role, team admin.** A team member is `admin` or `member` of that team. Org owners and admins appoint and demote team admins; a team admin cannot appoint another.
4. **A team admin may, for their own team only:**
   - add people who are already in the organization, and remove them;
   - create (link) projects in the team, within the organization's plan limits;
   - see the team's usage and cost.
5. **A team admin may not** invite anyone into the organization, change org roles, see org billing, rename or remove projects, or create, rename or delete teams.
6. **Org owners and admins keep every power they have today**, in every team. Members still see only their own teams' projects.
7. **Deleting a team that still has projects is refused.** Its projects are removed first, each with its own confirmation ([ADR 0028](0028-clean-removal.md) proposes one "Remove project" action). Moving a project to another team is not part of v2.
8. **The engine still grants access.** Joining a team gives the person an access ticket for each project in it, the first time they open that project. Someone on that engine with `members.manage` approves each one, as in v1. Leaving a team queues a member revocation on each of its projects.

### Permissions

| Action                                                        | Org owner | Org admin | Team admin (own team)   | Member (own teams) |
| ------------------------------------------------------------- | --------- | --------- | ----------------------- | ------------------ |
| See teams and their projects                                  | all       | all       | ✓                       | ✓                  |
| Open a project (access ticket on first open)                  | ✓         | ✓         | ✓                       | ✓                  |
| Add a person to the team (people already in the organization) | ✓         | ✓         | ✓                       |                    |
| Remove a person from the team                                 | ✓         | ✓\*       | ✓, org members only\*\* |                    |
| Appoint or demote a team admin                                | ✓         | ✓         |                         |                    |
| Link a project into the team                                  | ✓         | ✓         | ✓                       |                    |
| Rename or remove a project                                    | ✓         | ✓         |                         |                    |
| See the team's usage and cost                                 | ✓         | ✓         | ✓                       |                    |
| Create, rename or delete a team                               | ✓         | ✓         |                         |                    |
| Invite people into the organization                           | ✓         | ✓         |                         |                    |
| Change org roles, billing, delete the organization            | ✓         |           |                         |                    |
| Leave the team                                                | ✓         | ✓         | ✓                       | ✓                  |

\* As today, only an owner acts on an owner.

\*\* Not org owners or admins: removing someone queues a revocation on every project of the team, so a team admin must not be able to lock an org manager out.

In the policy table ([`policy.ts`](../../apps/dashboard/src/domain/authz/policy.ts)) this becomes a new rule scope, `team`: `{ scope: 'team', orgRoles: MANAGERS, teamRoles: ['admin'] }` allows org managers in any team of their organization and team admins in their own. The authorizer resolves the actor's team role from the resource's `teamId`; deny by default, and handlers still never compare role names.

| Action                    | Rule                                                                                     | Flags                       |
| ------------------------- | ---------------------------------------------------------------------------------------- | --------------------------- |
| `team.members.manage`     | was org `MANAGERS`; now `team` scope with team admins                                    | `SENSITIVE`, as today       |
| `team.engine.link` (new)  | `team` scope with team admins; entitlements gate it                                      | `PLAIN`, like `engine.link` |
| `team.usage.read` (new)   | `team` scope with team admins                                                            | `PLAIN`                     |
| `team.people.pick` (new)  | `team` scope with team admins: org people's name and email only, no roles or invitations | `PLAIN`                     |
| `team.roles.manage` (new) | org `MANAGERS`                                                                           | `SENSITIVE`                 |
| all others                | unchanged                                                                                |                             |

The recovery cooldown covers the `SENSITIVE` actions for team admins too, so a just-recovered account cannot add or remove people.

### Data model

- `engines.team_id`: drop the unique index `engines_team_id_unique` and add a plain index. No table rebuild.
- `team_members.role`: new column, `admin` or `member`, default `member`. No CHECK, like the org role column.
- **Access becomes per project.** `team_members.access` (`none`, `waiting`, `approved`) describes the one engine of a v1 team. It moves to a new table `engine_access (engine_id, user_id, access, updated_at)`, primary key `(engine_id, user_id)`. The migration copies each row through the team's engine, then drops the column. Ticket acks and revocations already carry the engine ID.
- `link_codes.team_id` already records the team a new project joins; a team admin's code always carries their team.
- Usage and cost read the existing daily rollups ([ADR 0022](0022-usage-data-in-d1.md)) filtered by the team's engine IDs. Cost is the team's share of what the organization's grant counts (projects, agents), shown as advisory, like licence coverage ([ADR 0021](0021-website-license-authority.md)). No invoices, prices or payment details.

### Engine roles

The dashboard proposes a role in every access ticket (`proposedRole`, closed to `admin` and `member`); the approver can change it. Org owners and admins get `admin`, as today. A team admin gets `admin` (open question 2), so that once they are on a project they can approve the team's next people there. Members get `member`.

### Approval across projects

Every project is its own authority, and passkeys are bound to the project's hostname, so a person registers one passkey per project anyway. The options for approvals:

| Option                                                                                                                                                                                                                     | Keeps the rule?                                                                | Cost                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| **A. One approval per project (proposed).** The dashboard shows the approver a checklist of the team's projects with a waiting request, and the person a list of projects to open.                                         | Yes                                                                            | One code per project; with three projects, three approvals             |
| **B. Engines trust each other's approvals.** Someone on project B opts in, once, to trust approvals signed by project A's engine key. A then signs "approved ticket T for user U", and B accepts a ticket that carries it. | Yes, because someone on B chose to trust A. But it is a new trust relationship | New signed message, peer key pinning on the engine, and revoking trust |
| **C. The dashboard says "already approved elsewhere".**                                                                                                                                                                    | No: the dashboard could then let anyone in. Rejected                           |                                                                        |

Recommendation: A now. B only if teams with many projects find A too slow; it would need its own ADR.

## Threat analysis

What changes is who in the organization can drive the dashboard side of access. What the platform can do to an engine does not change: tickets and revocations are the same signed messages as in ADR 0018, and every grant still needs someone on the engine.

| Case                                       | Result                                                                                                                                                                                                                              |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hijacked team admin account adds people    | Only people already in the organization, only to that team. Each still needs an approval on each engine, by someone who sees the 6-digit code from the person in front of them. No access.                                          |
| Hijacked team admin account removes people | Revocations on that team's projects for dashboard-joined members only; never an org owner or admin, never the engine's last owner; the engine owner can switch revocations off. A lockout, never access, and audited on both sides. |
| Team admin links a project they control    | Team members then open an engine the team admin runs, and may put data into it. The same is true of org admins today. The project shows who linked it, and members still approve nothing. Org managers can remove it.               |
| Team admin reaches another team            | The rule resolves the team role from the resource's team; another team answers as one that does not exist.                                                                                                                          |
| Team admin escalates                       | They cannot appoint team admins, change org roles or invite into the organization. `team.people.pick` returns names and emails only.                                                                                                |
| Dashboard compromise                       | As in ADR 0018: it can issue tickets, which still need approval on the engine, and queue revocations, which the engine can refuse. Several projects per team change the number of engines affected, not what can be done to each.   |

## Contract changes

None. Tickets, revocations, acks and the heartbeat are per engine already. The engine sees more tickets with `proposedRole: admin` if open question 2 goes that way; the role is a proposal the approver changes.

The real engine advertises `members@1` and `access-requests@1` since 0.119.0-139, so dashboard tickets and approvals work on it today. Teams v2 needs no further engine change beyond what ADR 0018 already asked for.

## Alternatives considered

- **A team admin who can also invite into the organization.** Simpler for departments, but anyone with a team admin role could then add strangers to the organization. Seb ruled it out.
- **One organization per department.** It works today, but splits billing and the people list, which is what companies asked not to do.
- **Only an engine role, no team role in the dashboard.** Engine admins already approve people, but they cannot add a colleague to the team in the dashboard, which is the missing step.
- **Keep one project per team and group teams into departments.** A second level of nesting for the same result; ADR 0018 chose flat teams with several engines as the growth path.

## Consequences

- Departments run themselves: a team admin adds colleagues and links projects, and org owners stop being the bottleneck.
- One new rule scope in the authorizer, a role column, a per-project access table and four policy actions. The teams spec's "not supported: an admin of a single team" is reversed and has to be updated, with the screens that show "the" engine of a team.
- More approvals: one per person per project, until open question 1 is settled.
- Today's "Delete project" (delete the team and revoke its one engine) no longer fits a team with several projects; deleting a team becomes an action on an empty team.
