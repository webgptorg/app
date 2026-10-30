import type { MembershipRecord } from '../domain/auth/records';
import { createMemoryAuthStore } from './memory-auth-store';
import { createMemoryAlertRecipients, createMemoryHeartbeatEngineReader } from './memory-engine-status';
import { createMemoryRegistrationStores } from './memory-registration-store';
import { createMemoryTeamStore } from './memory-team-store';
import { teamIdSchema } from '../domain/ids';
import { describeStatusStoreContract } from './status-store-contract';

describeStatusStoreContract('memory', () => {
    const auth = createMemoryAuthStore();
    const registration = createMemoryRegistrationStores({ orgExists: (orgId) => auth.state.orgs.has(orgId) });
    const teams = createMemoryTeamStore({ auth: auth.state, registration: registration.state });
    return {
        recipients: createMemoryAlertRecipients(auth.state, teams.state),
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
        addTeam(_orgId, engineId, userIds) {
            const teamId = teamIdSchema.parse(engineId);
            teams.state.engineTeams.set(engineId, teamId);
            teams.state.members.push(
                ...userIds.map((userId) => ({ teamId, userId, createdAt: 0, access: 'none' as const })),
            );
            return Promise.resolve();
        },
    };
});
