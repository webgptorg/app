import { testAccount } from './auth-store-contract';
import { createMemoryAuthStore } from './memory-auth-store';
import { createMemoryRegistrationStores } from './memory-registration-store';
import { describeRegistrationStoreContract } from './registration-store-contract';

describeRegistrationStoreContract('memory', () => {
    const auth = createMemoryAuthStore();
    const { linkCodes, engines, state } = createMemoryRegistrationStores({
        orgExists: (orgId) => auth.state.orgs.has(orgId),
    });
    return {
        linkCodes,
        engines,
        async addOrg() {
            const account = testAccount();
            await auth.accounts.createAccount(account);
            return account.orgId;
        },
        suspend(engine, reason) {
            state.engines.set(engine.engineId, { ...engine, status: 'suspended', statusReason: reason });
            return Promise.resolve();
        },
        orgAudit: (orgId) => Promise.resolve(state.orgAudit.filter((entry) => entry.orgId === orgId)),
    };
});
