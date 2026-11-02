import type { EngineId } from '@ptbk/protocol';

import type { InviteId, LinkCodeId, OrgId, TeamId, UserId } from '../domain/ids';
import type {
    InviteRecord,
    MemberAccess,
    RefusedRemovalRecord,
    TeamAudit,
    TeamRecord,
    TeamStore,
    TicketOutcome,
    TicketRecord,
} from '../domain/teams/team-store';
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
    ackedAt?: number;
    outcome?: string;
}

interface StoredTicket extends TicketRecord {
    outcome: TicketOutcome | null;
    noticedAt: number | null;
}

interface StoredMember {
    readonly teamId: TeamId;
    readonly userId: UserId;
    readonly createdAt: number;
    access: MemberAccess;
}

export interface MemoryTeamState {
    readonly teams: Map<TeamId, StoredTeam>;
    readonly members: StoredMember[];
    readonly tickets: StoredTicket[];
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
        tickets: [],
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
            state.revocations.push({
                id: `revocation-${String(nextRevocation).padStart(8, '0')}`,
                engineId,
                userId,
                createdAt: at,
            });
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
            state.members.push({ teamId: team.id, userId: creator, createdAt: team.createdAt, access: 'none' });
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
                    : [
                          {
                              userId: member.userId,
                              email: user.email,
                              role,
                              joinedAt: member.createdAt,
                              access: member.access,
                          },
                      ];
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
            state.members.push({ teamId, userId, createdAt: entry.at, access: 'none' });
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
        listRefused(orgId, teamId) {
            const engineId = liveTeam(orgId, teamId) === null ? null : engineOf(teamId);
            const ofEngine = state.revocations.filter((revocation) => revocation.engineId === engineId);
            const people = ofEngine.flatMap((revocation): RefusedRemovalRecord[] => {
                const user = deps.auth.users.get(revocation.userId);
                const outcome = revocation.outcome;
                if (
                    (outcome !== 'refused-disabled' && outcome !== 'refused-owner') ||
                    user === undefined ||
                    inTeam(teamId, revocation.userId) ||
                    ofEngine.some(
                        (other) =>
                            other.userId === revocation.userId &&
                            (other.createdAt > revocation.createdAt || other.ackedAt === undefined),
                    ) ||
                    state.tickets.some(
                        (ticket) =>
                            ticket.engineId === engineId &&
                            ticket.userId === revocation.userId &&
                            ticket.outcome === 'removed',
                    )
                ) {
                    return [];
                }
                return [
                    {
                        userId: revocation.userId,
                        email: user.email,
                        role: membership(orgId, revocation.userId)?.role ?? 'member',
                        joinedAt: revocation.createdAt,
                        outcome,
                    },
                ];
            });
            return Promise.resolve(people.sort((a, b) => (a.email < b.email ? -1 : 1)));
        },
        listRemoving(orgId, teamId) {
            const engineId = liveTeam(orgId, teamId) === null ? null : engineOf(teamId);
            const seen = new Set<UserId>();
            const people = state.revocations.flatMap((revocation) => {
                const user = deps.auth.users.get(revocation.userId);
                if (
                    revocation.engineId !== engineId ||
                    revocation.ackedAt !== undefined ||
                    inTeam(teamId, revocation.userId) ||
                    seen.has(revocation.userId) ||
                    user === undefined
                ) {
                    return [];
                }
                seen.add(revocation.userId);
                return [
                    {
                        userId: revocation.userId,
                        email: user.email,
                        role: membership(orgId, revocation.userId)?.role ?? 'member',
                        joinedAt: revocation.createdAt,
                    },
                ];
            });
            return Promise.resolve(people.sort((a, b) => (a.email < b.email ? -1 : 1)));
        },
        recordTicket(ticket) {
            state.tickets.push({ ...ticket, outcome: null, noticedAt: null });
            const member = state.members.find((m) => m.teamId === ticket.teamId && m.userId === ticket.userId);
            if (member?.access === 'none') {
                member.access = 'waiting';
            }
            return Promise.resolve();
        },
        applyTicketAck(engineId, ticketId, outcome) {
            const ticket = state.tickets.find(
                (candidate) => candidate.id === ticketId && candidate.engineId === engineId,
            );
            const team = ticket === undefined ? undefined : state.teams.get(ticket.teamId);
            const user = ticket === undefined ? undefined : deps.auth.users.get(ticket.userId);
            if (
                ticket === undefined ||
                team === undefined ||
                user === undefined ||
                !(ticket.outcome === null || (ticket.outcome === 'approved' && outcome === 'removed'))
            ) {
                return Promise.resolve(null);
            }
            ticket.outcome = outcome;
            const index = state.members.findIndex((m) => m.teamId === ticket.teamId && m.userId === ticket.userId);
            const member = state.members[index];
            if (member !== undefined) {
                if (outcome === 'removed') {
                    state.members.splice(index, 1);
                } else if (outcome === 'approved') {
                    member.access = 'approved';
                } else if (member.access === 'waiting') {
                    member.access = 'none';
                }
            }
            return Promise.resolve({
                orgId: team.orgId,
                teamId: team.id,
                teamName: team.name,
                userId: ticket.userId,
                email: user.email,
                locale: user.locale,
            });
        },
        ticketsAwaitingNotice(engineId, since) {
            const notices = state.tickets
                .filter(
                    (ticket) =>
                        ticket.engineId === engineId &&
                        ticket.outcome === null &&
                        ticket.noticedAt === null &&
                        ticket.issuedAt > since,
                )
                .sort((a, b) => a.issuedAt - b.issuedAt)
                .flatMap((ticket) => {
                    const team = state.teams.get(ticket.teamId);
                    const requester = deps.auth.users.get(ticket.userId);
                    if (team === undefined || requester === undefined) {
                        return [];
                    }
                    const inviters = new Set(
                        state.invites
                            .filter(
                                (invite) =>
                                    invite.orgId === team.orgId &&
                                    invite.email === requester.email &&
                                    invite.acceptedAt !== null,
                            )
                            .map((invite) => invite.invitedByUserId),
                    );
                    const recipients = deps.auth.memberships
                        .filter(
                            (candidate) =>
                                candidate.orgId === team.orgId &&
                                candidate.userId !== ticket.userId &&
                                (inviters.has(candidate.userId) ||
                                    ((candidate.role === 'owner' || candidate.role === 'admin') &&
                                        inTeam(team.id, candidate.userId))),
                        )
                        .flatMap((candidate) => {
                            const user = deps.auth.users.get(candidate.userId);
                            return user === undefined || user.emailVerifiedAt === null
                                ? []
                                : [{ email: user.email, locale: user.locale }];
                        })
                        .sort((a, b) => (a.email < b.email ? -1 : 1));
                    return [
                        {
                            ticketId: ticket.id,
                            orgId: team.orgId,
                            teamId: team.id,
                            teamName: team.name,
                            requesterEmail: requester.email,
                            recipients,
                        },
                    ];
                });
            return Promise.resolve(notices);
        },
        markNoticed(ticketIds, at) {
            for (const ticket of state.tickets.filter((candidate) => ticketIds.includes(candidate.id))) {
                ticket.noticedAt = at;
            }
            return Promise.resolve();
        },
        pendingRevocations(engineId, limit) {
            return Promise.resolve(
                state.revocations
                    .filter((revocation) => revocation.engineId === engineId && revocation.ackedAt === undefined)
                    .slice(0, limit)
                    .map(({ id, userId, createdAt }) => ({ id, userId, createdAt })),
            );
        },
        closeRevocation(engineId, revocationId, outcome, at) {
            const revocation = state.revocations.find(
                (candidate) =>
                    candidate.id === revocationId && candidate.engineId === engineId && candidate.ackedAt === undefined,
            );
            if (revocation !== undefined) {
                revocation.ackedAt = at;
                revocation.outcome = outcome;
            }
            return Promise.resolve();
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
                const creator = state.members.find(
                    (member) => member.teamId === named && member.userId === code?.createdByUserId,
                );
                if (creator !== undefined) creator.access = 'approved';
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
                state.members.push({
                    teamId: fallback.teamId,
                    userId: code.createdByUserId,
                    createdAt: fallback.at,
                    access: 'approved',
                });
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
                    state.members.push({ teamId, userId, createdAt: entry.at, access: 'none' });
                }
            }
            audit(invite.orgId, { ...entry, actorUserId: userId }, 'invite.accept', 'invite', invite.id);
            return Promise.resolve({ kind: 'accepted', orgId: invite.orgId });
        },
    };
    return { ...store, state };
}
