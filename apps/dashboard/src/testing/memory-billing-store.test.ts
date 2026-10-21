import { testAccount } from './auth-store-contract';
import { describeBillingStoreContract } from './billing-store-contract';
import { createMemoryAuthStore } from './memory-auth-store';
import { createMemoryBillingStore } from './memory-billing-store';

describeBillingStoreContract('memory', () => {
    const auth = createMemoryAuthStore();
    return {
        store: createMemoryBillingStore({ org: (orgId) => auth.state.orgs.get(orgId) }),
        async addOrg(input) {
            const account = testAccount();
            await auth.accounts.createAccount({ ...account, org: { ...account.org, name: input?.name ?? null } });
            return account.orgId;
        },
    };
});
