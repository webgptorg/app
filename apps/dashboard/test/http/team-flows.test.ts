import { createAuthHarness } from '../../src/testing/auth-harness';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';
import { createMemoryBillingStore } from '../../src/testing/memory-billing-store';
import { createMemoryRegistrationStores } from '../../src/testing/memory-registration-store';
import { createMemoryTeamStore } from '../../src/testing/memory-team-store';
import { describeTeamFlows } from '../../src/testing/team-flow-suite';

describeTeamFlows('teams on the in-memory stores', () => {
    const store = createMemoryAuthStore();
    const registration = createMemoryRegistrationStores({ orgExists: (orgId) => store.state.orgs.has(orgId) });
    const teams = createMemoryTeamStore({ auth: store.state, registration: registration.state });
    return {
        harness: createAuthHarness({
            store,
            billingStore: createMemoryBillingStore({ org: (orgId) => store.state.orgs.get(orgId) }),
            registration,
            teams,
        }),
        revokedOn: (userId) =>
            Promise.resolve(teams.state.revocations.filter((row) => row.userId === userId).map((row) => row.engineId)),
    };
});
