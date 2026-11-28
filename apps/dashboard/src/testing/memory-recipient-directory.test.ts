import type { MembershipRecord } from '../domain/auth/records';
import { newLinkCodeId, teamIdSchema } from '../domain/ids';
import { teamNameSchema } from '../shared/team-name';
import { cryptoRandom } from '../adapters/crypto-random';
import { createMemoryAuthStore } from './memory-auth-store';
import { createMemoryHeartbeatEngineReader } from './memory-engine-status';
import { createMemoryRecipientDirectory } from './memory-recipient-directory';
import { createMemoryRegistrationStores } from './memory-registration-store';
import { createMemoryTeamStore } from './memory-team-store';
import { describeRecipientDirectoryContract } from './recipient-directory-contract';

describeRecipientDirectoryContract('memory', () => {
    const auth = createMemoryAuthStore();
    const registration = createMemoryRegistrationStores({ orgExists: (orgId) => auth.state.orgs.has(orgId) });
    const teams = createMemoryTeamStore({ auth: auth.state, registration: registration.state });
    return {
        directory: createMemoryRecipientDirectory({
            auth: auth.state,
            teams: teams.state,
            registration: registration.state,
        }),
        engines: createMemoryHeartbeatEngineReader(registration.engines),
        async addAccount(account) {
            await auth.accounts.createAccount(account);
        },
        addMember(orgId, user, role) {
            auth.state.users.set(user.id, user);
            auth.state.memberships.push({ orgId, userId: user.id, role, createdAt: 0 } as unknown as MembershipRecord);
            return Promise.resolve();
        },
        addEngine(engine) {
            registration.state.engines.set(engine.engineId, engine);
            return Promise.resolve();
        },
        addTeam(orgId, engineId, name, people) {
            const teamId = teamIdSchema.parse(engineId);
            teams.state.teams.set(teamId, {
                id: teamId,
                orgId,
                name: teamNameSchema.parse(name),
                createdAt: 0,
                deletedAt: null,
            });
            teams.state.engineTeams.set(engineId, teamId);
            teams.state.members.push(...people.map(([userId, access]) => ({ teamId, userId, createdAt: 0, access })));
            return Promise.resolve();
        },
        addLinker(orgId, engineId, userId) {
            const id = newLinkCodeId(cryptoRandom);
            registration.state.linkCodes.set(id, {
                id,
                codeHash: id,
                orgId,
                createdByUserId: userId,
                createdAt: 0,
                expiresAt: 1,
                usedAt: 1,
                engineId,
            } as never);
            return Promise.resolve();
        },
        addTicket(engineId, userId, ticket) {
            teams.state.tickets.push({
                id: crypto.randomUUID(),
                teamId: teamIdSchema.parse(engineId),
                engineId,
                userId,
                issuedAt: ticket.issuedAt,
                expiresAt: ticket.issuedAt + 1,
                outcome: null,
                noticedAt: ticket.noticed ? ticket.issuedAt : null,
            });
            return Promise.resolve();
        },
    };
});
