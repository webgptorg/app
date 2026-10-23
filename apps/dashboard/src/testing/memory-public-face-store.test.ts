import { createMemoryPublicFaceStore } from './memory-public-face-store';
import { describePublicFaceStoreContract } from './public-face-store-contract';
import type { EngineRecord } from '../domain/registration/engine-store';
import { orgIdSchema } from '../domain/ids';
import { createTestEngine, engineRecord } from './test-engine';

describePublicFaceStoreContract('memory', () => {
    const engines = new Map<string, EngineRecord>();
    const store = createMemoryPublicFaceStore({ engines: () => engines.values() });
    return {
        store,
        async addEngine(status = 'active') {
            const row = engineRecord(await createTestEngine(), orgIdSchema.parse('a'.repeat(26)), { status });
            engines.set(row.engineId, row);
            return { engineId: row.engineId, hostname: row.hostname };
        },
        checksOf: (engineId) =>
            Promise.resolve(
                store.checks
                    .filter((check) => check.engineId === engineId)
                    .sort((a, b) => a.checkedAt - b.checkedAt)
                    .map(({ checkedAt, result }) => ({ checkedAt, result })),
            ),
    };
});
