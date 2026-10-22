import { env } from 'cloudflare:workers';

import { userIdSchema } from '../../domain/ids';
import { testAccount } from '../../testing/auth-store-contract';
import { describeCustomHostnameStoreContract } from '../../testing/custom-hostname-store-contract';
import { createTestEngine, engineRecord } from '../../testing/test-engine';
import { createDatabase } from './client';
import { createD1AuthStore } from './d1-auth-store';
import { createD1CustomHostnameStore } from './d1-custom-hostname-store';
import { engines } from './schema';

describeCustomHostnameStoreContract('D1', () => {
    const db = createDatabase(env.DB);
    return {
        store: createD1CustomHostnameStore(db),
        async addEngine() {
            const account = testAccount();
            await createD1AuthStore(db).accounts.createAccount(account);
            const engine = await createTestEngine();
            await db.insert(engines).values(engineRecord(engine, account.orgId));
            return { engine, orgId: account.orgId };
        },
        async auditFor(engineId) {
            const rows = await env.DB.prepare(
                'SELECT id, admin_user_id, action, target_type, target_id, reason, created_at FROM admin_audit_log WHERE target_id LIKE ?',
            )
                .bind(`${engineId}/%`)
                .all<{
                    id: string;
                    admin_user_id: string;
                    action: string;
                    target_type: string;
                    target_id: string;
                    reason: string | null;
                    created_at: number;
                }>();
            return rows.results.map((row) => ({
                id: row.id,
                adminUserId: userIdSchema.parse(row.admin_user_id),
                action: row.action,
                targetType: row.target_type,
                targetId: row.target_id,
                reason: row.reason,
                createdAt: row.created_at,
            }));
        },
    };
});
