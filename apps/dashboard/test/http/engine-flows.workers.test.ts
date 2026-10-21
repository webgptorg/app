import { env } from 'cloudflare:workers';

import { createDatabase } from '../../src/adapters/db/client';
import { createD1AuthStore } from '../../src/adapters/db/d1-auth-store';
import { createD1BillingStore } from '../../src/adapters/db/d1-billing-store';
import { createD1EngineStore, createD1LinkCodeStore } from '../../src/adapters/db/d1-registration-store';
import { createAuthHarness } from '../../src/testing/auth-harness';
import { describeEngineFlows } from '../../src/testing/engine-flow-suite';

describeEngineFlows(
    'engine registration on D1',
    () => {
        const db = createDatabase(env.DB);
        return createAuthHarness({
            store: createD1AuthStore(db),
            billingStore: createD1BillingStore(db),
            registration: { linkCodes: createD1LinkCodeStore(db), engines: createD1EngineStore(db) },
        });
    },
    async () => {
        const rows = await env.DB.prepare('SELECT * FROM link_codes').all();
        return rows.results.flatMap((row) => Object.values(row));
    },
    async (_, engineId) => {
        await env.DB.prepare(
            "UPDATE engines SET status = 'suspended', status_reason = 'owner-revoked' WHERE engine_id = ?",
        )
            .bind(engineId)
            .run();
    },
);
