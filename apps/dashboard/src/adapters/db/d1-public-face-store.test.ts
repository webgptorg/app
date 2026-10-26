import { env } from 'cloudflare:workers';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { testAccount } from '../../testing/auth-store-contract';
import { describePublicFaceStoreContract } from '../../testing/public-face-store-contract';
import { createTestEngine, engineRecord } from '../../testing/test-engine';
import { createDatabase } from './client';
import { createD1AuthStore } from './d1-auth-store';
import { createD1ActiveEngineDirectory, createD1PublicFaceStore } from './d1-public-face-store';
import { engines, publicFaceChecks } from './schema';

describePublicFaceStoreContract('D1', () => {
    const db = createDatabase(env.DB);
    return {
        store: createD1PublicFaceStore(db),
        async addEngine(status = 'active') {
            const account = testAccount();
            await createD1AuthStore(db).accounts.createAccount(account);
            const row = engineRecord(await createTestEngine(), account.orgId, { status });
            await db.insert(engines).values(row);
            return { engineId: row.engineId, hostname: row.hostname };
        },
        async checksOf(engineId) {
            return db
                .select({ checkedAt: publicFaceChecks.checkedAt, result: publicFaceChecks.result })
                .from(publicFaceChecks)
                .where(eq(publicFaceChecks.engineId, engineId))
                .orderBy(asc(publicFaceChecks.checkedAt))
                .all();
        },
    };
});

describe('createD1ActiveEngineDirectory', () => {
    it('lists active engines’ default hostnames by engine ID, up to the limit', async () => {
        const db = createDatabase(env.DB);
        const account = testAccount();
        await createD1AuthStore(db).accounts.createAccount(account);
        const active = engineRecord(await createTestEngine(), account.orgId);
        const suspended = engineRecord(await createTestEngine(), account.orgId, { status: 'suspended' });
        await db.insert(engines).values([active, suspended]);
        const listed = await createD1ActiveEngineDirectory(db).list(10_000);
        expect(listed).toContainEqual({ engineId: active.engineId, hostname: active.hostname });
        expect(listed.map((engine) => engine.engineId)).not.toContain(suspended.engineId);
        expect(listed.map((engine) => engine.engineId)).toEqual(listed.map((engine) => engine.engineId).sort());
        expect(await createD1ActiveEngineDirectory(db).list(1)).toHaveLength(1);
    });
});
