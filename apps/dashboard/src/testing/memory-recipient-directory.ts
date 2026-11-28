import type { EngineId } from '@ptbk/protocol';

import type { OrgId } from '../domain/ids';
import { orgRoleSchema } from '../domain/roles';
import type { ProjectPlace, RecipientDirectory } from '../domain/notifications/recipient-directory';
import {
    asRecipient,
    directoryPeople,
    inAudience,
    type DirectoryMember,
} from '../domain/notifications/recipient-rules';
import { projectName } from '../shared/engine-label';
import type { MemoryAuthState } from './memory-auth-store';
import type { MemoryRegistrationState } from './memory-registration-store';
import type { MemoryTeamState } from './memory-team-store';

/** The D1 directory's reads over the in-memory accounts, teams and engines, as the D1 tables share one database. */
export function createMemoryRecipientDirectory(deps: {
    readonly auth: MemoryAuthState;
    readonly teams: MemoryTeamState;
    readonly registration: MemoryRegistrationState;
}): RecipientDirectory {
    const everyone = (orgId: OrgId, engineId: EngineId | null) => {
        const engine = engineId === null ? undefined : deps.registration.engines.get(engineId);
        if (engineId !== null && engine?.orgId !== orgId) {
            return null;
        }
        const teamId = engineId === null ? undefined : deps.teams.engineTeams.get(engineId);
        const linker = [...deps.registration.linkCodes.values()]
            .filter((code) => code.engineId === engineId && code.orgId === orgId && code.usedAt !== null)
            .sort((a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0))[0];
        const members = deps.auth.memberships
            .filter((membership) => membership.orgId === orgId)
            .flatMap((membership): DirectoryMember[] => {
                const user = deps.auth.users.get(membership.userId);
                const role = orgRoleSchema.safeParse(membership.role);
                const member = deps.teams.members.find(
                    (candidate) => candidate.teamId === teamId && candidate.userId === membership.userId,
                );
                return user === undefined || !role.success
                    ? []
                    : [
                          {
                              userId: user.id,
                              email: user.email,
                              emailVerified: user.emailVerifiedAt !== null,
                              locale: user.locale,
                              orgRole: role.data,
                              access: teamId === undefined ? undefined : member?.access,
                          },
                      ];
            })
            .sort((a, b) => (a.email < b.email ? -1 : 1));
        return directoryPeople(members, engineId === null ? null : { linkerUserId: linker?.createdByUserId ?? null });
    };
    return {
        resolve: (orgId, engineId, audience) =>
            Promise.resolve(
                (everyone(orgId, engineId) ?? []).filter((person) => inAudience(person, audience)).map(asRecipient),
            ),
        member(orgId, engineId, userId) {
            const person = everyone(orgId, engineId)?.find((candidate) => candidate.userId === userId);
            return Promise.resolve(person?.sees === true ? asRecipient(person) : null);
        },
        place(orgId, engineId) {
            const org = deps.auth.orgs.get(orgId);
            if (org === undefined) {
                return Promise.resolve(null);
            }
            if (engineId === null) {
                return Promise.resolve<ProjectPlace>({ orgName: org.name, project: null });
            }
            const engine = deps.registration.engines.get(engineId);
            if (engine?.orgId !== orgId) {
                return Promise.resolve(null);
            }
            const teamId = deps.teams.engineTeams.get(engineId);
            const team = teamId === undefined ? undefined : deps.teams.teams.get(teamId);
            const teamName = team === undefined || team.deletedAt !== null ? null : team.name;
            return Promise.resolve<ProjectPlace>({
                orgName: org.name,
                project: {
                    label: projectName({ ...engine, teamName }),
                    hostname: engine.hostname,
                    active: engine.status === 'active',
                },
            });
        },
        waitingRequesters(engineId, since) {
            const emails = deps.teams.tickets
                .filter(
                    (ticket) =>
                        ticket.engineId === engineId &&
                        ticket.outcome === null &&
                        ticket.noticedAt !== null &&
                        ticket.issuedAt > since,
                )
                .flatMap((ticket) => {
                    const user = deps.auth.users.get(ticket.userId);
                    return user === undefined ? [] : [user.email];
                });
            return Promise.resolve([...new Set(emails)].sort().slice(0, 20));
        },
    };
}
