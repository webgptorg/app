import { env } from 'cloudflare:workers';

import { testAccount } from '../../testing/auth-store-contract';
import { describeCtStoreContract } from '../../testing/ct-store-contract';
import { createTestEngine, engineRecord } from '../../testing/test-engine';
import { createDatabase } from './client';
import { createD1AuthStore } from './d1-auth-store';
import { createD1CtStore } from './d1-ct-store';
import { engines } from './schema';

describeCtStoreContract('D1', () => {
    const db = createDatabase(env.DB);
    return {
        store: createD1CtStore(db),
        async addEngine(hostname) {
            const account = testAccount();
            await createD1AuthStore(db).accounts.createAccount(account);
            const row = engineRecord(await createTestEngine(), account.orgId);
            await db.insert(engines).values({ ...row, hostname });
        },
    };
});
