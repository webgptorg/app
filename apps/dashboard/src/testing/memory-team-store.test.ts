import { createMemoryAuthStore } from './memory-auth-store';
import { createMemoryRegistrationStores } from './memory-registration-store';
import { createMemoryTeamStore } from './memory-team-store';
import { describeTeamStoreContract } from './team-store-contract';

describeTeamStoreContract('memory', () => {
    const auth = createMemoryAuthStore();
    const registration = createMemoryRegistrationStores({ orgExists: (orgId) => auth.state.orgs.has(orgId) });
    const teams = createMemoryTeamStore({ auth: auth.state, registration: registration.state });
    return {
        teams,
        linkCodes: registration.linkCodes,
        async addAccount(account) {
            await auth.accounts.createAccount(account);
        },
        addMember(orgId, user, role) {
            auth.state.users.set(user.id, user);
            auth.state.memberships.push({ orgId, userId: user.id, role, createdAt: 0 });
            return Promise.resolve();
        },
        revocations: (orgId) =>
            Promise.resolve(
                teams.state.revocations
                    .filter((row) => registration.state.engines.get(row.engineId)?.orgId === orgId)
                    .map(({ engineId, userId }) => ({ engineId, userId })),
            ),
        auditActions: (orgId) =>
            Promise.resolve(registration.state.orgAudit.filter((row) => row.orgId === orgId).map((row) => row.action)),
        storedCommitment: (codeHash) =>
            Promise.resolve(registration.state.linkCodes.get(codeHash)?.ownerSetupCommitment ?? null),
    };
});
