import { env } from 'cloudflare:workers';

import { createDatabase } from '../../src/adapters/db/client';
import { createD1AuthStore } from '../../src/adapters/db/d1-auth-store';
import { createD1BillingStore } from '../../src/adapters/db/d1-billing-store';
import {
    createD1EngineStore,
    createD1LinkCodeStore,
    createD1PlatformEngineStore,
} from '../../src/adapters/db/d1-registration-store';
import { createD1RegistryReader } from '../../src/adapters/db/d1-registry-store';
import { createD1HeartbeatEngineReader } from '../../src/adapters/db/d1-status-store';
import { orgIdSchema, userIdSchema } from '../../src/domain/ids';
import { createAuthHarness } from '../../src/testing/auth-harness';
import { describeEngineListFlows } from '../../src/testing/engine-list-flow-suite';

describeEngineListFlows('engine list on D1', (options) => {
    const db = createDatabase(env.DB);
    return {
        harness: createAuthHarness({
            ...options,
            store: createD1AuthStore(db),
            billingStore: createD1BillingStore(db),
            registration: {
                linkCodes: createD1LinkCodeStore(db),
                engines: createD1EngineStore(db),
                platformEngines: createD1PlatformEngineStore(db),
            },
            registry: createD1RegistryReader(db),
            heartbeatEngines: createD1HeartbeatEngineReader(db),
        }),
        async orgAudit(orgId) {
            const rows = await env.DB.prepare(
                'SELECT org_id, actor_user_id, action, target_type, target_id FROM org_audit_log WHERE org_id = ? ORDER BY created_at',
            )
                .bind(orgId)
                .all<Record<string, string>>();
            return rows.results.map((row) => ({
                orgId: orgIdSchema.parse(row['org_id']),
                actorUserId: userIdSchema.parse(row['actor_user_id']),
                action: String(row['action']),
                targetType: String(row['target_type']),
                targetId: String(row['target_id']),
            }));
        },
    };
});
