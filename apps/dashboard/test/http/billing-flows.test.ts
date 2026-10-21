import { createAuthHarness } from '../../src/testing/auth-harness';
import { describeBillingFlows } from '../../src/testing/billing-flow-suite';
import { createMemoryAuthStore } from '../../src/testing/memory-auth-store';
import { createMemoryBillingStore } from '../../src/testing/memory-billing-store';

describeBillingFlows(
    'billing flows on the in-memory stores',
    () => {
        const store = createMemoryAuthStore();
        return createAuthHarness({
            store,
            billingStore: createMemoryBillingStore({ org: (orgId) => store.state.orgs.get(orgId) }),
        });
    },
    async (harness, email) => {
        const { state } = harness.store as ReturnType<typeof createMemoryAuthStore>;
        const user = await harness.store.accounts.findUserByEmail(email);
        if (user === null) {
            throw new Error('no such user');
        }
        state.users.set(user.id, { ...user, platformRole: 'admin' });
    },
);
