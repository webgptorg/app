import type { UserId } from '../ids';
import type { OrgRole } from '../roles';
import type { LastOwner, TeamStore } from './team-store';
import { teamAudit, type TeamActor, type TeamDeps } from './teams';

export type PeopleDeps = Pick<TeamDeps, 'teams' | 'clock' | 'random'> & {
    readonly teams: Pick<TeamStore, 'listOrgMembers' | 'changeRole' | 'removeFromOrg'>;
};

/** Only an owner may act on an owner: an admin can neither demote nor remove one. */
async function targetAllowed(deps: PeopleDeps, actor: TeamActor, userId: UserId): Promise<boolean> {
    if (actor.orgRole === 'owner') {
        return true;
    }
    const target = (await deps.teams.listOrgMembers(actor.orgId)).find((member) => member.userId === userId);
    return target?.role !== 'owner';
}

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
    if (!(await targetAllowed(deps, actor, userId))) {
        return 'forbidden';
    }
    return deps.teams.removeFromOrg(actor.orgId, userId, teamAudit(deps, actor));
}

export function leaveOrg(deps: PeopleDeps, actor: TeamActor): Promise<'removed' | 'not-found' | LastOwner> {
    return deps.teams.removeFromOrg(actor.orgId, actor.userId, teamAudit(deps, actor));
}
