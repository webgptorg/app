import { createAuthHarness } from '../../src/testing/auth-harness';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';
import { createMemoryBillingStore } from '../../src/testing/memory-billing-store';
import { createMemoryRegistrationStores } from '../../src/testing/memory-registration-store';
import { createMemoryRelayTokenStore } from '../../src/testing/memory-registry-stores';
import { describeRegistryFlows } from '../../src/testing/registry-flow-suite';

describeRegistryFlows('registry API on the in-memory stores', () => {
    const store = createMemoryAuthStore();
    const registration = createMemoryRegistrationStores({ orgExists: (orgId) => store.state.orgs.has(orgId) });
    const relayTokens = createMemoryRelayTokenStore();
    return {
        harness: createAuthHarness({
            store,
            billingStore: createMemoryBillingStore({ org: (orgId) => store.state.orgs.get(orgId) }),
            registration,
            relayTokens,
        }),
        addRelayToken(row) {
            relayTokens.rows.set(row.id, row);
            return Promise.resolve();
        },
        revokeRelayToken(id, at) {
            const row = relayTokens.rows.get(id);
            if (row !== undefined) {
                relayTokens.rows.set(id, { ...row, revokedAt: at });
            }
            return Promise.resolve();
        },
        relayToken: (id) => Promise.resolve(relayTokens.rows.get(id) ?? null),
        suspend(engineId) {
            const engine = registration.state.engines.get(engineId);
            if (engine !== undefined) {
                registration.state.engines.set(engineId, { ...engine, status: 'suspended', statusReason: 'test' });
            }
            return Promise.resolve();
        },
    };
});
