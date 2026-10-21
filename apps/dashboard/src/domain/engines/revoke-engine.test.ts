import { describe, expect, it } from 'vitest';

import { createTestEngine, engineRecord } from '../../testing/test-engine';
import { createTestRegistration, REGISTRATION_START_MS } from '../../testing/test-registration';
import { orgIdSchema, userIdSchema } from '../ids';
import { revokeEngine } from './revoke-engine';

const ORG_A = orgIdSchema.parse('aaaaaaaaaaaaaaaaaaaaaaaaaa');
const ORG_B = orgIdSchema.parse('bbbbbbbbbbbbbbbbbbbbbbbbbb');
const OWNER = userIdSchema.parse('uuuuuuuuuuuuuuuuuuuuuuuuuu');
const NOW = REGISTRATION_START_MS;

describe('revokeEngine', () => {
    it('suspends the engine for good with one audit entry, and logs the engine ID only', async () => {
        const { stores, clock, logger } = createTestRegistration();
        const engine = await createTestEngine();
        stores.state.engines.set(engine.engineId, engineRecord(engine, ORG_A));
        const random = { bytes: (length: number) => new Uint8Array(length) };
        const deps = { engines: stores.engines, clock, random, logger };

        expect(await revokeEngine(deps, { orgId: ORG_B, userId: OWNER }, engine.engineId)).toBe('not-found');
        expect(await revokeEngine(deps, { orgId: ORG_A, userId: OWNER }, engine.engineId)).toBe('revoked');
        expect(await revokeEngine(deps, { orgId: ORG_A, userId: OWNER }, engine.engineId)).toBe('already-revoked');

        expect(stores.state.engines.get(engine.engineId)).toMatchObject({
            status: 'suspended',
            statusReason: 'owner-revoked',
            updatedAt: NOW,
        });
        expect(stores.state.orgAudit).toEqual([
            {
                id: 'a'.repeat(26),
                orgId: ORG_A,
                actorUserId: OWNER,
                action: 'engine.revoke',
                targetType: 'engine',
                targetId: engine.engineId,
                createdAt: NOW,
            },
        ]);
        expect(logger.entries).toEqual([
            { level: 'info', event: 'engines.revoked', fields: { engineId: engine.engineId } },
        ]);
    });
});
