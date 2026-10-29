import { describe, expect, it } from 'vitest';

import { engineLabelSchema } from '../../shared/engine-label';
import { createTestEngine, engineRecord } from '../../testing/test-engine';
import { createTestRegistration, REGISTRATION_START_MS } from '../../testing/test-registration';
import { orgIdSchema, userIdSchema } from '../ids';
import { renameEngine } from './rename-engine';

const ORG_A = orgIdSchema.parse('aaaaaaaaaaaaaaaaaaaaaaaaaa');
const ORG_B = orgIdSchema.parse('bbbbbbbbbbbbbbbbbbbbbbbbbb');
const OWNER = userIdSchema.parse('uuuuuuuuuuuuuuuuuuuuuuuuuu');
const NOW = REGISTRATION_START_MS;

describe('renameEngine', () => {
    it('labels the organization’s engine with one audit entry, and logs the engine ID only', async () => {
        const { stores, clock, logger } = createTestRegistration();
        const engine = await createTestEngine();
        stores.state.engines.set(engine.engineId, engineRecord(engine, ORG_A));
        const random = { bytes: (length: number) => new Uint8Array(length) };
        const deps = { engines: stores.engines, clock, random, logger };
        const label = engineLabelSchema.parse('Production');

        expect(await renameEngine(deps, { orgId: ORG_B, userId: OWNER }, engine.engineId, label)).toBe('not-found');
        expect(await renameEngine(deps, { orgId: ORG_A, userId: OWNER }, engine.engineId, label)).toBe('renamed');
        expect(await renameEngine(deps, { orgId: ORG_A, userId: OWNER }, engine.engineId, label)).toBe('unchanged');

        expect(stores.state.engines.get(engine.engineId)).toMatchObject({ label, updatedAt: NOW });
        expect(stores.state.orgAudit).toEqual([
            {
                id: 'a'.repeat(26),
                orgId: ORG_A,
                actorUserId: OWNER,
                action: 'engine.rename',
                targetType: 'engine',
                targetId: engine.engineId,
                createdAt: NOW,
            },
        ]);
        expect(logger.entries).toEqual([
            { level: 'info', event: 'engines.renamed', fields: { engineId: engine.engineId } },
        ]);
    });
});
