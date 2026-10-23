import { createAuthHarness } from '../../src/testing/auth-harness';
import { describeEngineSuspensionFlows } from '../../src/testing/engine-suspension-flow-suite';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';
import { createMemoryBillingStore } from '../../src/testing/memory-billing-store';
import { createMemoryRegistrationStores } from '../../src/testing/memory-registration-store';
import { createMemoryRelayTokenStore } from '../../src/testing/memory-registry-stores';

describeEngineSuspensionFlows('engine suspension on the in-memory stores', () => {
    const store = createMemoryAuthStore();
    const relayTokens = createMemoryRelayTokenStore();
    const harness = createAuthHarness({
        store,
        billingStore: createMemoryBillingStore({ org: (orgId) => store.state.orgs.get(orgId) }),
        registration: createMemoryRegistrationStores({
            orgExists: (orgId) => store.state.orgs.has(orgId),
            adminAudit: store.adminAudit,
        }),
        relayTokens,
    });
    return {
        harness,
        async makeAdmin(email) {
            const user = await store.accounts.findUserByEmail(email);
            if (user === null) {
                throw new Error('no such user');
            }
            store.state.users.set(user.id, { ...user, platformRole: 'admin' });
        },
        addRelayToken(row) {
            relayTokens.rows.set(row.id, row);
            return Promise.resolve();
        },
        engineAudit: (engineId) =>
            Promise.resolve(
                store.state.adminAudit.filter((entry) => entry.targetType === 'engine' && entry.targetId === engineId),
            ),
    };
});
