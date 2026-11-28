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
import { createD1TeamStore } from '../../src/adapters/db/d1-team-store';
import { createD1MeteringStore } from '../../src/adapters/db/d1-metering-store';
import { createD1NotificationStore } from '../../src/adapters/db/d1-notification-store';
import { createD1RecipientDirectory } from '../../src/adapters/db/d1-recipient-directory';
import { createAuthHarness } from '../../src/testing/auth-harness';
import { describeTeamFlows } from '../../src/testing/team-flow-suite';

describeTeamFlows('teams on D1', () => {
    const db = createDatabase(env.DB);
    return {
        harness: createAuthHarness({
            store: createD1AuthStore(db),
            billingStore: createD1BillingStore(db),
            registration: {
                linkCodes: createD1LinkCodeStore(db),
                engines: createD1EngineStore(db),
                platformEngines: createD1PlatformEngineStore(db),
            },
            registry: createD1RegistryReader(db),
            heartbeatEngines: createD1HeartbeatEngineReader(db),
            teams: createD1TeamStore(db),
            metering: createD1MeteringStore(db),
            notifications: { store: createD1NotificationStore(db), directory: createD1RecipientDirectory(db) },
        }),
        async revokedOn(userId) {
            const rows = await env.DB.prepare(
                'SELECT engine_id FROM member_revocations WHERE user_id = ? ORDER BY created_at',
            )
                .bind(userId)
                .all<{ engine_id: string }>();
            return rows.results.map((row) => row.engine_id);
        },
    };
});
