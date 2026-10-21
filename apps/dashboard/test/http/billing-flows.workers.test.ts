import { env } from 'cloudflare:workers';

import { createDatabase } from '../../src/adapters/db/client';
import { createD1AuthStore } from '../../src/adapters/db/d1-auth-store';
import { createD1BillingStore } from '../../src/adapters/db/d1-billing-store';
import { createAuthHarness } from '../../src/testing/auth-harness';
import { describeBillingFlows } from '../../src/testing/billing-flow-suite';

describeBillingFlows(
    'billing flows on D1',
    () => {
        const db = createDatabase(env.DB);
        return createAuthHarness({ store: createD1AuthStore(db), billingStore: createD1BillingStore(db) });
    },
    // What scripts/make-admin.md runs with `wrangler d1 execute`.
    async (_, email) => {
        await env.DB.prepare("UPDATE users SET platform_role = 'admin' WHERE email = ?").bind(email).run();
    },
);
