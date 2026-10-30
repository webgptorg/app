import type { EngineId } from '@ptbk/protocol';

import type { InviteId, LinkCodeId, OrgId, TeamId, UserId } from '../domain/ids';
import type { InviteRecord, TeamAudit, TeamRecord, TeamStore } from '../domain/teams/team-store';
import type { TeamName } from '../shared/team-name';
import type { MemoryAuthState } from './memory-auth-store';
import type { MemoryRegistrationState } from './memory-registration-store';

interface StoredTeam {
    readonly id: TeamId;
    readonly orgId: OrgId;
    name: TeamName;
    readonly createdAt: number;
    deletedAt: number | null;
}

interface StoredInvite extends InviteRecord {
    acceptedAt: number | null;
    revokedAt: number | null;
}

export interface StoredRevocation {
    readonly id: string;
    readonly engineId: EngineId;
    readonly userId: UserId;
    readonly createdAt: number;
}

export interface MemoryTeamState {
    readonly teams: Map<TeamId, StoredTeam>;
    readonly members: { teamId: TeamId; userId: UserId; createdAt: number }[];
    readonly invites: StoredInvite[];
    readonly revocations: StoredRevocation[];
    /** `engines.team_id`. */
    readonly engineTeams: Map<EngineId, TeamId>;
    /** `link_codes.team_id`. */
    readonly linkCodeTeams: Map<LinkCodeId, TeamId>;
}

/**
 * {@link TeamStore} in memory over the auth and registration stores' state, as the D1 tables share one database; the
 * contract suite holds it to the D1 adapter's behaviour.
 */
export function createMemoryTeamStore(deps: {
    readonly auth: MemoryAuthState;
    readonly registration: MemoryRegistrationState;
}): TeamStore & { readonly state: MemoryTeamState } {
    const state: MemoryTeamState = {
        teams: new Map(),
        members: [],
        invites: [],
        revocations: [],
        engineTeams: new Map(),
        linkCodeTeams: new Map(),
    };
    let nextRevocation = 0;

    const liveTeam = (orgId: OrgId, teamId: TeamId) => {
        const team = state.teams.get(teamId);
        return team?.orgId === orgId && team.deletedAt === null ? team : null;
    };
    const engineOf = (teamId: TeamId) => [...state.engineTeams].find(([, bound]) => bound === teamId)?.[0] ?? null;
    const toTeam = (team: StoredTeam): TeamRecord => ({
        id: team.id,
        orgId: team.orgId,
        name: team.name,
        createdAt: team.createdAt,
        engineId: engineOf(team.id),
        memberCount: state.members.filter((member) => member.teamId === team.id).length,
    });
    const membership = (orgId: OrgId, userId: UserId) =>
        deps.auth.memberships.find((candidate) => candidate.orgId === orgId && candidate.userId === userId) ?? null;
    const inTeam = (teamId: TeamId, userId: UserId) =>
        state.members.some((member) => member.teamId === teamId && member.userId === userId);
    const ordered = (teams: readonly StoredTeam[]) =>
        [...teams].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
    const liveTeams = (orgId: OrgId) =>
        ordered([...state.teams.values()].filter((team) => team.orgId === orgId && team.deletedAt === null));
    const audit = (orgId: OrgId, entry: TeamAudit, action: string, targetType: string, targetId: string) => {
        deps.registration.orgAudit.push({ ...entry, orgId, action, targetType, targetId, createdAt: entry.at });
    };
    const revoke = (teamId: TeamId, userId: UserId, at: number) => {
        const engineId = engineOf(teamId);
        if (engineId !== null && inTeam(teamId, userId)) {
            nextRevocation += 1;
            state.revocations.push({ id: `revocation-${String(nextRevocation)}`, engineId, userId, createdAt: at });
        }
    };
    const removeFromTeam = (teamId: TeamId, userId: UserId, at: number) => {
        revoke(teamId, userId, at);
        const index = state.members.findIndex((member) => member.teamId === teamId && member.userId === userId);
        if (index >= 0) {
            state.members.splice(index, 1);
        }
    };
    const isPending = (invite: StoredInvite, now: number) =>
        invite.acceptedAt === null && invite.revokedAt === null && now < invite.expiresAt;
    const lastOwner = (orgId: OrgId, userId: UserId) =>
        membership(orgId, userId)?.role === 'owner' &&
        deps.auth.memberships.filter((candidate) => candidate.orgId === orgId && candidate.role === 'owner').length ===
            1;
    const strip = (invite: StoredInvite): InviteRecord => ({
        id: invite.id,
        tokenHash: invite.tokenHash,
        orgId: invite.orgId,
        email: invite.email,
        role: invite.role,
        teamIds: invite.teamIds,
        invitedByUserId: invite.invitedByUserId,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
    });

    const store: TeamStore = {
        create(team, creator, entry) {
            state.teams.set(team.id, { ...team, deletedAt: null });
            state.members.push({ teamId: team.id, userId: creator, createdAt: team.createdAt });
            audit(team.orgId, entry, 'team.create', 'team', team.id);
            return Promise.resolve();
        },
        list: (orgId) => Promise.resolve(liveTeams(orgId).map(toTeam)),
        listForUser: (orgId, userId) =>
            Promise.resolve(
                liveTeams(orgId)
                    .filter((team) => inTeam(team.id, userId))
                    .map(toTeam),
            ),
        find(orgId, teamId) {
            const team = liveTeam(orgId, teamId);
            return Promise.resolve(team === null ? null : toTeam(team));
        },
        isMember: (orgId, teamId, userId) =>
            Promise.resolve(liveTeam(orgId, teamId) !== null && inTeam(teamId, userId)),
        rename(orgId, teamId, name, entry) {
            const team = liveTeam(orgId, teamId);
            if (team === null) {
                return Promise.resolve('not-found');
            }
            team.name = name;
            audit(orgId, entry, 'team.rename', 'team', teamId);
            return Promise.resolve('renamed');
        },
        delete(orgId, teamId, entry) {
            const team = liveTeam(orgId, teamId);
            if (team === null) {
                return Promise.resolve('not-found');
            }
            for (const member of state.members.filter((candidate) => candidate.teamId === teamId)) {
                removeFromTeam(teamId, member.userId, entry.at);
            }
            team.deletedAt = entry.at;
            audit(orgId, entry, 'team.delete', 'team', teamId);
            return Promise.resolve('deleted');
        },
        listMembers(orgId, teamId) {
            if (liveTeam(orgId, teamId) === null) {
                return Promise.resolve([]);
            }
            const people = state.members.flatMap((member) => {
                const user = deps.auth.users.get(member.userId);
                const role = membership(orgId, member.userId)?.role;
                return member.teamId !== teamId || user === undefined || role === undefined
                    ? []
                    : [{ userId: member.userId, email: user.email, role, joinedAt: member.createdAt }];
            });
            return Promise.resolve(people.sort((a, b) => (a.email < b.email ? -1 : 1)));
        },
        addMember(orgId, teamId, userId, entry) {
            if (liveTeam(orgId, teamId) === null) {
                return Promise.resolve('not-found');
            }
            if (membership(orgId, userId) === null) {
                return Promise.resolve('not-member');
            }
            if (inTeam(teamId, userId)) {
                return Promise.resolve('already');
            }
            state.members.push({ teamId, userId, createdAt: entry.at });
            audit(orgId, entry, 'team.member.add', 'user', userId);
            return Promise.resolve('added');
        },
        removeMember(orgId, teamId, userId, entry) {
            if (liveTeam(orgId, teamId) === null || !inTeam(teamId, userId)) {
                return Promise.resolve('not-found');
            }
            removeFromTeam(teamId, userId, entry.at);
            audit(orgId, entry, 'team.member.remove', 'user', userId);
            return Promise.resolve('removed');
        },
        engineIdsForUser(orgId, userId) {
            const ids = liveTeams(orgId)
                .filter((team) => inTeam(team.id, userId))
                .flatMap((team) => {
                    const engineId = engineOf(team.id);
                    return engineId === null ? [] : [engineId];
                });
            return Promise.resolve(new Set(ids));
        },
        attachLinkCode(orgId, linkCodeId, teamId) {
            const code = [...deps.registration.linkCodes.values()].find((candidate) => candidate.id === linkCodeId);
            const team = liveTeam(orgId, teamId);
            if (code?.orgId !== orgId || code.usedAt !== null || team === null || engineOf(teamId) !== null) {
                return Promise.resolve('not-found');
            }
            state.linkCodeTeams.set(linkCodeId, teamId);
            return Promise.resolve('attached');
        },
        bindNewEngine(engineId, fallback) {
            const engine = deps.registration.engines.get(engineId);
            if (engine === undefined || state.engineTeams.has(engineId)) {
                return Promise.resolve();
            }
            const code = [...deps.registration.linkCodes.values()]
                .filter((candidate) => candidate.engineId === engineId)
                .sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0))[0];
            const named = code === undefined ? undefined : state.linkCodeTeams.get(code.id);
            if (named !== undefined && liveTeam(engine.orgId, named) !== null && engineOf(named) === null) {
                state.engineTeams.set(engineId, named);
                return Promise.resolve();
            }
            state.teams.set(fallback.teamId, {
                id: fallback.teamId,
                orgId: engine.orgId,
                name: fallback.name,
                createdAt: fallback.at,
                deletedAt: null,
            });
            state.engineTeams.set(engineId, fallback.teamId);
            if (code !== undefined && membership(engine.orgId, code.createdByUserId) !== null) {
                state.members.push({ teamId: fallback.teamId, userId: code.createdByUserId, createdAt: fallback.at });
            }
            return Promise.resolve();
        },
        listOrgMembers(orgId) {
            const people = deps.auth.memberships.flatMap((candidate) => {
                const user = deps.auth.users.get(candidate.userId);
                return candidate.orgId !== orgId || user === undefined
                    ? []
                    : [
                          {
                              userId: candidate.userId,
                              email: user.email,
                              role: candidate.role,
                              joinedAt: candidate.createdAt,
                              teamIds: liveTeams(orgId)
                                  .filter((team) => inTeam(team.id, candidate.userId))
                                  .map((team) => team.id),
                          },
                      ];
            });
            return Promise.resolve(people.sort((a, b) => (a.email < b.email ? -1 : 1)));
        },
        changeRole(orgId, userId, role, entry) {
            const current = membership(orgId, userId);
            if (current === null) {
                return Promise.resolve('not-found');
            }
            if (current.role === role) {
                return Promise.resolve('unchanged');
            }
            if (lastOwner(orgId, userId)) {
                return Promise.resolve('last-owner');
            }
            const index = deps.auth.memberships.indexOf(current);
            deps.auth.memberships[index] = { ...current, role };
            audit(orgId, entry, 'org.member.role', 'user', userId);
            return Promise.resolve('changed');
        },
        removeFromOrg(orgId, userId, entry) {
            const current = membership(orgId, userId);
            if (current === null) {
                return Promise.resolve('not-found');
            }
            if (lastOwner(orgId, userId)) {
                return Promise.resolve('last-owner');
            }
            for (const team of [...state.teams.values()].filter((candidate) => candidate.orgId === orgId)) {
                if (team.deletedAt === null) {
                    revoke(team.id, userId, entry.at);
                }
                const index = state.members.findIndex(
                    (member) => member.teamId === team.id && member.userId === userId,
                );
                if (index >= 0) {
                    state.members.splice(index, 1);
                }
            }
            deps.auth.memberships.splice(deps.auth.memberships.indexOf(current), 1);
            audit(orgId, entry, 'org.member.remove', 'user', userId);
            return Promise.resolve('removed');
        },
        insertInvite(invite, entry) {
            if (state.invites.some((candidate) => candidate.tokenHash === invite.tokenHash)) {
                return Promise.reject(new Error('UNIQUE constraint failed: invites.token_hash'));
            }
            state.invites.push({ ...invite, acceptedAt: null, revokedAt: null });
            audit(invite.orgId, entry, 'invite.create', 'invite', invite.id);
            return Promise.resolve();
        },
        listPendingInvites(orgId, now) {
            return Promise.resolve(
                state.invites
                    .filter((invite) => invite.orgId === orgId && isPending(invite, now))
                    .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
                    .map(strip),
            );
        },
        previewInvite(tokenHash, now) {
            const invite = state.invites.find((candidate) => candidate.tokenHash === tokenHash);
            if (invite === undefined || !isPending(invite, now)) {
                return Promise.resolve(null);
            }
            const teamNames = liveTeams(invite.orgId)
                .filter((team) => invite.teamIds.includes(team.id))
                .map((team) => team.name);
            return Promise.resolve({
                invite: strip(invite),
                orgName: deps.auth.orgs.get(invite.orgId)?.name ?? null,
                teamNames,
            });
        },
        renewInvite(orgId, inviteId, renewal, entry) {
            const index = state.invites.findIndex(
                (candidate) =>
                    candidate.id === inviteId && candidate.orgId === orgId && isPending(candidate, renewal.now),
            );
            const invite = state.invites[index];
            if (invite === undefined) {
                return Promise.resolve(null);
            }
            const renewed = { ...invite, tokenHash: renewal.tokenHash, expiresAt: renewal.expiresAt };
            state.invites[index] = renewed;
            audit(orgId, entry, 'invite.resend', 'invite', inviteId);
            return Promise.resolve(strip(renewed));
        },
        revokeInvite(orgId, inviteId: InviteId, entry) {
            const invite = state.invites.find(
                (candidate) => candidate.id === inviteId && candidate.orgId === orgId && isPending(candidate, entry.at),
            );
            if (invite === undefined) {
                return Promise.resolve('not-found');
            }
            invite.revokedAt = entry.at;
            audit(orgId, entry, 'invite.revoke', 'invite', inviteId);
            return Promise.resolve('revoked');
        },
        acceptInvite(tokenHash, userId, entry) {
            const invite = state.invites.find((candidate) => candidate.tokenHash === tokenHash);
            if (invite === undefined || !isPending(invite, entry.at)) {
                return Promise.resolve({ kind: 'invalid' });
            }
            invite.acceptedAt = entry.at;
            if (membership(invite.orgId, userId) === null) {
                deps.auth.memberships.push({ orgId: invite.orgId, userId, role: invite.role, createdAt: entry.at });
            }
            for (const teamId of invite.teamIds) {
                if (liveTeam(invite.orgId, teamId) !== null && !inTeam(teamId, userId)) {
                    state.members.push({ teamId, userId, createdAt: entry.at });
                }
            }
            audit(invite.orgId, { ...entry, actorUserId: userId }, 'invite.accept', 'invite', invite.id);
            return Promise.resolve({ kind: 'accepted', orgId: invite.orgId });
        },
    };
    return { ...store, state };
}
