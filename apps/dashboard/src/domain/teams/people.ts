import type { UserId } from '../ids';
import type { OrgRole } from '../roles';
import type { LastOwner, TeamStore } from './team-store';
import { mayActOn, teamAudit, type TeamActor, type TeamDeps } from './teams';

export type PeopleDeps = Pick<TeamDeps, 'teams' | 'clock' | 'random'> & {
    readonly teams: Pick<TeamStore, 'listOrgMembers' | 'changeRole' | 'removeFromOrg'>;
};

export function changeOrgRole(
    deps: PeopleDeps,
    actor: TeamActor,
    userId: UserId,
    role: OrgRole,
): Promise<'changed' | 'unchanged' | 'not-found' | LastOwner> {
    return deps.teams.changeRole(actor.orgId, userId, role, teamAudit(deps, actor));
}

/** Out of every team and the organization; each team with an engine gets a member revocation queued. */
export async function removeFromOrg(
    deps: PeopleDeps,
    actor: TeamActor,
    userId: UserId,
): Promise<'removed' | 'not-found' | 'forbidden' | LastOwner> {
    if (!(await mayActOn(deps, actor, userId))) {
        return 'forbidden';
    }
    return deps.teams.removeFromOrg(actor.orgId, userId, teamAudit(deps, actor));
}

export function leaveOrg(deps: PeopleDeps, actor: TeamActor): Promise<'removed' | 'not-found' | LastOwner> {
    return deps.teams.removeFromOrg(actor.orgId, actor.userId, teamAudit(deps, actor));
}
