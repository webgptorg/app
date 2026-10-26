import { describe, expect, it } from 'vitest';

import { createTestEngine, engineRecord } from '../../testing/test-engine';
import { createTestRegistration, REGISTRATION_START_MS } from '../../testing/test-registration';
import { orgIdSchema, userIdSchema } from '../ids';
import { suspendEngine, unsuspendEngine } from './suspend-engine';

const ORG = orgIdSchema.parse('aaaaaaaaaaaaaaaaaaaaaaaaaa');
const ADMIN = userIdSchema.parse('uuuuuuuuuuuuuuuuuuuuuuuuuu');
const NOW = REGISTRATION_START_MS;

describe('suspendEngine and unsuspendEngine', () => {
    it('audit the admin and the reason, and log the engine ID only, on a change only', async () => {
        const { stores, clock, logger } = createTestRegistration();
        const engine = await createTestEngine();
        stores.state.engines.set(engine.engineId, engineRecord(engine, ORG));
        const random = { bytes: (length: number) => new Uint8Array(length) };
        const deps = { platformEngines: stores.platformEngines, clock, random, logger };
        const input = { engineId: engine.engineId, adminUserId: ADMIN, reason: 'Report #7' };

        expect(await suspendEngine(deps, input)).toBe('suspended');
        expect(await suspendEngine(deps, input)).toBe('already-suspended');
        expect(stores.state.engines.get(engine.engineId)).toMatchObject({
            status: 'suspended',
            statusReason: 'platform-suspended',
        });
        expect(await unsuspendEngine(deps, { ...input, reason: 'Appeal' })).toBe('unsuspended');
        expect(await unsuspendEngine(deps, { ...input, reason: 'Appeal' })).toBe('not-suspended');

        expect(stores.adminAuditEntries).toEqual([
            {
                id: 'a'.repeat(26),
                adminUserId: ADMIN,
                action: 'admin.engine.suspend',
                targetType: 'engine',
                targetId: engine.engineId,
                reason: 'Report #7',
                createdAt: NOW,
            },
            {
                id: 'a'.repeat(26),
                adminUserId: ADMIN,
                action: 'admin.engine.unsuspend',
                targetType: 'engine',
                targetId: engine.engineId,
                reason: 'Appeal',
                createdAt: NOW,
            },
        ]);
        expect(logger.entries).toEqual([
            { level: 'info', event: 'engines.suspended', fields: { engineId: engine.engineId } },
            { level: 'info', event: 'engines.unsuspended', fields: { engineId: engine.engineId } },
        ]);
    });
});
