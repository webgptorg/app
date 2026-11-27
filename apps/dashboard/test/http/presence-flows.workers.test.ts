import { env } from 'cloudflare:workers';
import { beforeEach } from 'vitest';

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
import { createD1RelayPresenceStore } from '../../src/adapters/db/d1-relay-presence-store';
import { createAuthHarness } from '../../src/testing/auth-harness';
import { describePresenceFlows, PRESENCE_RELAYS } from '../../src/testing/presence-flow-suite';

beforeEach(async () => {
    await env.DB.prepare('DELETE FROM relay_presence_reports').run();
});

describePresenceFlows('relay presence on D1', () => {
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
            relayPresence: createD1RelayPresenceStore(db),
            relays: PRESENCE_RELAYS,
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
    };
});
