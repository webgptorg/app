import { describe, expect, it } from 'vitest';

import type { MonitorState } from './alert-rules';
import { DEFAULT_THRESHOLDS } from './alert-rules';
import { createMonitorService } from './monitor-store';

function memoryStorage() {
    let stored: MonitorState | null = null;
    return {
        stored: () => stored,
        load: () => Promise.resolve(stored),
        save: (state: MonitorState) => {
            stored = state;
            return Promise.resolve();
        },
    };
}

describe('createMonitorService', () => {
    it('queues the alerts of observations and job runs until they are settled as delivered', async () => {
        const storage = memoryStorage();
        const service = createMonitorService({
            storage,
            thresholds: { ...DEFAULT_THRESHOLDS, cronFailures: 1, unreachableChecks: 1 },
        });
        await expect(service.pending()).resolves.toEqual([]);
        await service.recordJobRun({ job: 'relay-monitor', outcome: 'failed', at: 1 });
        await service.observe({
            at: 2,
            relays: [{ relay: 'relay-a', kind: 'down', reason: 'timeout' }],
            dashboardHealthy: true,
            counts: null,
        });
        const pending = await service.pending();
        expect(pending.map((item) => `${item.alert.rule} ${item.alert.subject}`)).toEqual([
            'cron-job-failing relay-monitor',
            'relay-unreachable relay-a',
        ]);
        await expect(
            service.settle([
                { id: pending[0]?.id ?? '', delivered: true },
                { id: pending[1]?.id ?? '', delivered: false },
            ]),
        ).resolves.toEqual([]);
        expect((await service.pending()).map((item) => [item.alert.rule, item.attempts])).toEqual([
            ['relay-unreachable', 1],
        ]);
        expect(Object.keys(storage.stored()?.open ?? {})).toEqual([
            'cron-job-failing:relay-monitor',
            'relay-unreachable:relay-a',
        ]);
    });
});
