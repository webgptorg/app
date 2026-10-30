import { describe, expect, it } from 'vitest';

import { testOrgId } from '../../testing/billing-fixtures';
import { createTestEngine } from '../../testing/test-engine';
import { signedHeartbeat } from '../../testing/test-heartbeat';
import { createStatusTestDeps, STATUS_START_MS as START } from '../../testing/test-status';
import type { EngineStatus } from '../registration/engine-store';
import type { RecordHeartbeatInput } from './engine-status-directory';
import { createEngineStatusService } from './engine-status-service';
import { ingestHeartbeat } from './ingest-heartbeat';

async function setup(status: EngineStatus | null) {
    const engine = await createTestEngine();
    const orgId = testOrgId();
    const t = createStatusTestDeps();
    const service = createEngineStatusService(t.deps);
    const recorded: RecordHeartbeatInput[] = [];
    const deps = {
        clock: t.clock,
        logger: t.logger,
        heartbeatEngines: {
            findEngine: () =>
                Promise.resolve(status === null ? null : { orgId, publicKey: engine.publicKey, status, label: null }),
        },
        engineStatus: {
            recordHeartbeat: (input: RecordHeartbeatInput) => (recorded.push(input), service.recordHeartbeat(input)),
            getStatus: () => service.getStatus(),
            reset: () => service.reset(),
        },
    };
    const { body, signature } = await signedHeartbeat(engine, 1, START);
    const ingest = (signatureHeader: string | null = signature) =>
        ingestHeartbeat(deps, { engineId: engine.engineId, rawBody: body, signatureHeader });
    return { ...t, engine, orgId, recorded, ingest };
}

describe('ingestHeartbeat', () => {
    it('hands an active engine’s heartbeat to its object with the row’s organization and key, logging nothing', async () => {
        const t = await setup('active');
        expect((await t.ingest()).kind).toBe('accepted');
        expect(t.recorded).toEqual([
            expect.objectContaining({
                engineId: t.engine.engineId,
                orgId: t.orgId,
                publicKey: t.engine.publicKey,
                receivedAt: START,
            }),
        ]);
        expect(t.logger.entries).toEqual([]);
    });

    it('stops an unknown and a suspended engine before its object is touched', async () => {
        for (const [status, kind] of [
            [null, 'unknown-engine'],
            ['suspended', 'engine-suspended'],
        ] as const) {
            const t = await setup(status);
            expect(await t.ingest()).toEqual({ kind });
            expect(t.recorded).toEqual([]);
            expect(t.logger.entries).toEqual([
                { level: 'warn', event: 'heartbeat.refused', fields: { engineId: t.engine.engineId, outcome: kind } },
            ]);
        }
    });

    it('logs the engine ID and the outcome kind of a refused heartbeat, and nothing else', async () => {
        const t = await setup('active');
        expect(await t.ingest(null)).toEqual({ kind: 'bad-signature-header' });
        expect(t.logger.entries).toEqual([
            {
                level: 'warn',
                event: 'heartbeat.refused',
                fields: { engineId: t.engine.engineId, outcome: 'bad-signature-header' },
            },
        ]);
    });
});
