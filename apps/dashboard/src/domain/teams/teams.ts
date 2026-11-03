import type { EngineId } from '@ptbk/protocol';

import type { TeamName } from '../../shared/team-name';
import type { Actor } from '../authz/authorizer';
import { newOrgAuditEntryId, newTeamId, type TeamId, type UserId } from '../ids';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { Random } from '../ports/random';
import type { EngineStore } from '../registration/engine-store';
import type { TeamAudit, TeamPersonRecord, TeamRecord, TeamStore } from './team-store';

export interface TeamDeps {
    readonly teams: TeamStore;
    readonly engines: Pick<EngineStore, 'revoke'>;
    readonly clock: Clock;
    readonly random: Random;
    readonly logger: Logger;
}

export type TeamActor = Pick<Actor, 'orgId' | 'userId' | 'orgRole'>;

/** Owners and admins see every team of the organization (ADR 0018); members only the ones they are in. */
export function seesAllTeams(actor: Pick<Actor, 'orgRole'>): boolean {
    return actor.orgRole === 'owner' || actor.orgRole === 'admin';
}

export function teamAudit(deps: Pick<TeamDeps, 'clock' | 'random'>, actor: Pick<Actor, 'userId'>): TeamAudit {
    return { id: newOrgAuditEntryId(deps.random), actorUserId: actor.userId, at: deps.clock.nowMs() };
}

export function listTeams(deps: Pick<TeamDeps, 'teams'>, actor: TeamActor): Promise<readonly TeamRecord[]> {
    return seesAllTeams(actor) ? deps.teams.list(actor.orgId) : deps.teams.listForUser(actor.orgId, actor.userId);
}

/** A team the actor may see; null for one they may not, exactly as for one that does not exist. */
export async function findVisibleTeam(
    deps: Pick<TeamDeps, 'teams'>,
    actor: TeamActor,
    teamId: TeamId,
): Promise<TeamRecord | null> {
    const team = await deps.teams.find(actor.orgId, teamId);
    if (team === null || seesAllTeams(actor) || (await deps.teams.isMember(actor.orgId, teamId, actor.userId))) {
        return team;
    }
    return null;
}

/** The engines a member may see; null means every engine of the organization. */
export async function visibleEngineIds(
    deps: Pick<TeamDeps, 'teams'>,
    actor: TeamActor,
): Promise<ReadonlySet<EngineId> | null> {
    return seesAllTeams(actor) ? null : deps.teams.engineIdsForUser(actor.orgId, actor.userId);
}

export async function createTeam(deps: TeamDeps, actor: TeamActor, name: TeamName): Promise<TeamRecord> {
    const audit = teamAudit(deps, actor);
    const id = newTeamId(deps.random);
    await deps.teams.create({ id, orgId: actor.orgId, name, createdAt: audit.at }, actor.userId, audit);
    deps.logger.info('teams.created', { teamId: id });
    return { id, orgId: actor.orgId, name, createdAt: audit.at, engineId: null, memberCount: 1 };
}

export function renameTeam(deps: TeamDeps, actor: TeamActor, teamId: TeamId, name: TeamName) {
    return deps.teams.rename(actor.orgId, teamId, name, teamAudit(deps, actor));
}

/**
 * The team's engine is revoked first, as `engine.revoke` would, so relays stop routing it; then the team goes with its
 * people. The engine keeps running on its machine with its data.
 */
export async function deleteTeam(deps: TeamDeps, actor: TeamActor, teamId: TeamId): Promise<'deleted' | 'not-found'> {
    const team = await deps.teams.find(actor.orgId, teamId);
    if (team === null) {
        return 'not-found';
    }
    if (team.engineId !== null) {
        await deps.engines.revoke(actor.orgId, team.engineId, teamAudit(deps, actor));
    }
    const outcome = await deps.teams.delete(actor.orgId, teamId, teamAudit(deps, actor));
    deps.logger.info('teams.deleted', { teamId });
    return outcome;
}

export async function listTeamMembers(
    deps: Pick<TeamDeps, 'teams'>,
    actor: TeamActor,
    teamId: TeamId,
): Promise<readonly TeamPersonRecord[] | null> {
    const team = await findVisibleTeam(deps, actor, teamId);
    return team === null ? null : deps.teams.listMembers(actor.orgId, teamId);
}

export function addTeamMember(deps: TeamDeps, actor: TeamActor, teamId: TeamId, userId: UserId) {
    return deps.teams.addMember(actor.orgId, teamId, userId, teamAudit(deps, actor));
}

/** Only an owner may act on an owner: an admin can neither demote nor remove one, from a team or the organization. */
export async function mayActOn(
    deps: { readonly teams: Pick<TeamStore, 'listOrgMembers'> },
    actor: TeamActor,
    userId: UserId,
): Promise<boolean> {
    if (actor.orgRole === 'owner' || userId === actor.userId) {
        return true;
    }
    const target = (await deps.teams.listOrgMembers(actor.orgId)).find((member) => member.userId === userId);
    return target?.role !== 'owner';
}

/**
 * Also the way out of a team for the actor themselves (`team.leave`). Leaving the team queues a revocation on its
 * engine, so an admin taking an owner out would be the removal `removeFromOrg` refuses, one team at a time.
 */
export async function removeTeamMember(
    deps: TeamDeps,
    actor: TeamActor,
    teamId: TeamId,
    userId: UserId,
): Promise<'removed' | 'not-found' | 'forbidden'> {
    if (!(await mayActOn(deps, actor, userId))) {
        return 'forbidden';
    }
    return deps.teams.removeMember(actor.orgId, teamId, userId, teamAudit(deps, actor));
}
