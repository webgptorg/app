import { createAuthHarness } from '../../src/testing/auth-harness';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';
import { createMemoryBillingStore } from '../../src/testing/memory-billing-store';
import { createMemoryRegistrationStores } from '../../src/testing/memory-registration-store';
import { createMemoryRelayTokenStore } from '../../src/testing/memory-registry-stores';
import { describePresenceFlows, PRESENCE_RELAYS } from '../../src/testing/presence-flow-suite';

describePresenceFlows('relay presence on the in-memory stores', () => {
    const store = createMemoryAuthStore();
    const relayTokens = createMemoryRelayTokenStore();
    return {
        harness: createAuthHarness({
            store,
            billingStore: createMemoryBillingStore({ org: (orgId) => store.state.orgs.get(orgId) }),
            registration: createMemoryRegistrationStores({ orgExists: (orgId) => store.state.orgs.has(orgId) }),
            relayTokens,
            relays: PRESENCE_RELAYS,
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
    };
});
