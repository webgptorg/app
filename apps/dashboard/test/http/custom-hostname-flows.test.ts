import type { AdminAuditEntry } from '../../src/domain/auth/records';
import { createAuthHarness } from '../../src/testing/auth-harness';
import { describeCustomHostnameFlows } from '../../src/testing/custom-hostname-flow-suite';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';
import { createMemoryBillingStore } from '../../src/testing/memory-billing-store';
import { createMemoryRegistrationStores } from '../../src/testing/memory-registration-store';
import { createMemoryRelayTokenStore } from '../../src/testing/memory-registry-stores';

describeCustomHostnameFlows('custom hostnames on the in-memory stores', () => {
    const store = createMemoryAuthStore();
    const relayTokens = createMemoryRelayTokenStore();
    const harness = createAuthHarness({
        store,
        billingStore: createMemoryBillingStore({ org: (orgId) => store.state.orgs.get(orgId) }),
        registration: createMemoryRegistrationStores({ orgExists: (orgId) => store.state.orgs.has(orgId) }),
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
        auditFor: (engineId) =>
            Promise.resolve(
                store.state.adminAudit.filter((entry: AdminAuditEntry) => entry.targetId.startsWith(`${engineId}/`)),
            ),
    };
});
