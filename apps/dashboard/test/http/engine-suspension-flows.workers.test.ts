import { env } from 'cloudflare:workers';

import { createDatabase } from '../../src/adapters/db/client';
import { createD1MeteringStore } from '../../src/adapters/db/d1-metering-store';
import { createD1AuthStore } from '../../src/adapters/db/d1-auth-store';
import { createD1BillingStore } from '../../src/adapters/db/d1-billing-store';
import {
    createD1EngineStore,
    createD1LinkCodeStore,
    createD1PlatformEngineStore,
} from '../../src/adapters/db/d1-registration-store';
import { createD1RegistryReader, createD1RelayTokenStore } from '../../src/adapters/db/d1-registry-store';
import { userIdSchema } from '../../src/domain/ids';
import { createAuthHarness } from '../../src/testing/auth-harness';
import { describeEngineSuspensionFlows } from '../../src/testing/engine-suspension-flow-suite';

describeEngineSuspensionFlows('engine suspension on D1', () => {
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
            metering: createD1MeteringStore(db),
            relayTokens: createD1RelayTokenStore(db),
            registry: createD1RegistryReader(db),
        }),
        async makeAdmin(email) {
            await env.DB.prepare("UPDATE users SET platform_role = 'admin' WHERE email = ?").bind(email).run();
        },
        async addRelayToken(row) {
            await env.DB.prepare(
                'INSERT INTO relay_tokens (id, relay_id, token_hash, created_at, expires_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
                .bind(row.id, row.relayId, row.tokenHash, row.createdAt, row.expiresAt, row.lastUsedAt, row.revokedAt)
                .run();
        },
        async engineAudit(engineId) {
            const rows = await env.DB.prepare(
                "SELECT id, admin_user_id, action, target_type, target_id, reason, created_at FROM admin_audit_log WHERE target_type = 'engine' AND target_id = ? ORDER BY created_at, rowid",
            )
                .bind(engineId)
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
