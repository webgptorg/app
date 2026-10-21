import { env } from 'cloudflare:workers';

import { createDatabase } from '../../src/adapters/db/client';
import { createD1AuthStore } from '../../src/adapters/db/d1-auth-store';
import { createD1BillingStore } from '../../src/adapters/db/d1-billing-store';
import { createD1EngineStore, createD1LinkCodeStore } from '../../src/adapters/db/d1-registration-store';
import { createD1AlertRecipients, createD1HeartbeatEngineReader } from '../../src/adapters/db/d1-status-store';
import { createAuthHarness } from '../../src/testing/auth-harness';
import { describeHeartbeatFlows, FLOW_HEARTBEAT } from '../../src/testing/heartbeat-flow-suite';

describeHeartbeatFlows('heartbeats on D1', () => {
    const db = createDatabase(env.DB);
    return {
        harness: createAuthHarness({
            store: createD1AuthStore(db),
            billingStore: createD1BillingStore(db),
            registration: { linkCodes: createD1LinkCodeStore(db), engines: createD1EngineStore(db) },
            heartbeatEngines: createD1HeartbeatEngineReader(db),
            alertRecipients: createD1AlertRecipients(db),
            heartbeat: FLOW_HEARTBEAT,
        }),
        async suspend(engineId) {
            await env.DB.prepare("UPDATE engines SET status = 'suspended', status_reason = 'test' WHERE engine_id = ?")
                .bind(engineId)
                .run();
        },
    };
});
