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
import { relayTokenIdSchema } from '../../src/domain/ids';
import { createAuthHarness } from '../../src/testing/auth-harness';
import { describeRegistryFlows } from '../../src/testing/registry-flow-suite';

describeRegistryFlows('registry API on D1', () => {
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
        async addRelayToken(row) {
            await env.DB.prepare(
                'INSERT INTO relay_tokens (id, relay_id, token_hash, created_at, expires_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
                .bind(row.id, row.relayId, row.tokenHash, row.createdAt, row.expiresAt, row.lastUsedAt, row.revokedAt)
                .run();
        },
        async revokeRelayToken(id, at) {
            await env.DB.prepare('UPDATE relay_tokens SET revoked_at = ? WHERE id = ?').bind(at, id).run();
        },
        async relayToken(id) {
            const row = await env.DB.prepare(
                'SELECT id, relay_id, token_hash, created_at, expires_at, last_used_at, revoked_at FROM relay_tokens WHERE id = ?',
            )
                .bind(id)
                .first<{
                    id: string;
                    relay_id: string;
                    token_hash: string;
                    created_at: number;
                    expires_at: number;
                    last_used_at: number | null;
                    revoked_at: number | null;
                }>();
            return row === null
                ? null
                : {
                      id: relayTokenIdSchema.parse(row.id),
                      relayId: row.relay_id,
                      tokenHash: row.token_hash,
                      createdAt: row.created_at,
                      expiresAt: row.expires_at,
                      lastUsedAt: row.last_used_at,
                      revokedAt: row.revoked_at,
                  };
        },
        async suspend(engineId) {
            await env.DB.prepare("UPDATE engines SET status = 'suspended', status_reason = 'test' WHERE engine_id = ?")
                .bind(engineId)
                .run();
        },
    };
});
