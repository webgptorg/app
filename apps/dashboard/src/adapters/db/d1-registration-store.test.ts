import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';

import { testAccount } from '../../testing/auth-store-contract';
import { describeRegistrationStoreContract } from '../../testing/registration-store-contract';
import { orgAuditEntryIdSchema, orgIdSchema, userIdSchema } from '../../domain/ids';
import { createDatabase } from './client';
import { createD1AuthStore } from './d1-auth-store';
import { createD1EngineStore, createD1LinkCodeStore } from './d1-registration-store';
import { orgAuditLog } from './schema';

describeRegistrationStoreContract('D1', () => {
    const db = createDatabase(env.DB);
    const accounts = createD1AuthStore(db).accounts;
    return {
        linkCodes: createD1LinkCodeStore(db),
        engines: createD1EngineStore(db),
        async addOrg() {
            const account = testAccount();
            await accounts.createAccount(account);
            return account.orgId;
        },
        async suspend(engine, reason) {
            await env.DB.prepare("UPDATE engines SET status = 'suspended', status_reason = ? WHERE engine_id = ?")
                .bind(reason, engine.engineId)
                .run();
        },
        async orgAudit(orgId) {
            const rows = await db
                .select()
                .from(orgAuditLog)
                .where(eq(orgAuditLog.orgId, orgId))
                .orderBy(orgAuditLog.createdAt)
                .all();
            return rows.map((row) => ({
                ...row,
                id: orgAuditEntryIdSchema.parse(row.id),
                orgId: orgIdSchema.parse(row.orgId),
                actorUserId: userIdSchema.parse(row.actorUserId),
            }));
        },
    };
});
