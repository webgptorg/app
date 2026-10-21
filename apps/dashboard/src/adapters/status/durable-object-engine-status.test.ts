import { describe, expect, it } from 'vitest';

import { testOrgId } from '../../testing/billing-fixtures';
import { createTestEngine } from '../../testing/test-engine';
import { createDurableObjectEngineStatus, type EngineStatusNamespace } from './durable-object-engine-status';

describe('Durable Object engine status directory', () => {
    it('addresses one object per engine by its engine ID and forwards each call', async () => {
        const engine = await createTestEngine();
        const calls: string[] = [];
        const namespace: EngineStatusNamespace = {
            idFromName: (name) => ({ name }) as unknown as DurableObjectId,
            get: (id) => {
                const name = (id as unknown as { name: string }).name;
                return {
                    recordHeartbeat: (input) => (
                        calls.push(`record ${name} ${input.engineId}`),
                        Promise.resolve({ kind: 'bad-signature' })
                    ),
                    getStatus: () => (calls.push(`status ${name}`), Promise.resolve({ state: 'never-seen' })),
                    reset: () => (calls.push(`reset ${name}`), Promise.resolve()),
                };
            },
        };
        const directory = createDurableObjectEngineStatus(namespace);
        const outcome = await directory.recordHeartbeat({
            engineId: engine.engineId,
            orgId: testOrgId(),
            publicKey: engine.publicKey,
            rawBody: new Uint8Array(),
            signatureHeader: null,
            receivedAt: 0,
        });
        expect(outcome).toEqual({ kind: 'bad-signature' });
        expect(await directory.getStatus(engine.engineId)).toEqual({ state: 'never-seen' });
        await directory.reset(engine.engineId);
        expect(calls).toEqual([
            `record ${engine.engineId} ${engine.engineId}`,
            `status ${engine.engineId}`,
            `reset ${engine.engineId}`,
        ]);
    });
});
