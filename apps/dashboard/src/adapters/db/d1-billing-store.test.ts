import { env } from 'cloudflare:workers';

import { testAccount } from '../../testing/auth-store-contract';
import { describeBillingStoreContract } from '../../testing/billing-store-contract';
import { createDatabase } from './client';
import { createD1AuthStore } from './d1-auth-store';
import { createD1BillingStore } from './d1-billing-store';

describeBillingStoreContract('D1', () => {
    const db = createDatabase(env.DB);
    const accounts = createD1AuthStore(db).accounts;
    return {
        store: createD1BillingStore(db),
        async addOrg(input) {
            const account = testAccount();
            await accounts.createAccount({ ...account, org: { ...account.org, name: input?.name ?? null } });
            return account.orgId;
        },
    };
});
