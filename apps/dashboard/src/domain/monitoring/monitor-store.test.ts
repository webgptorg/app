import { describe, expect, it } from 'vitest';

import type { MonitorState } from './alert-rules';
import { DEFAULT_THRESHOLDS } from './alert-rules';
import { createMonitorService } from './monitor-store';

describe('createMonitorService', () => {
    it('observes from the initial state when nothing is stored', async () => {
        const service = createMonitorService({
            storage: { load: () => Promise.resolve(null), save: () => Promise.resolve() },
            thresholds: DEFAULT_THRESHOLDS,
        });
        await expect(service.observe({ at: 1, relays: [], dashboardHealthy: true, counts: null })).resolves.toEqual([]);
    });

    it('starts from the initial state, keeps what each call leaves, and answers its alerts', async () => {
        let stored: MonitorState | null = null;
        const service = createMonitorService({
            storage: {
                load: () => Promise.resolve(stored),
                save: (state) => {
                    stored = state;
                    return Promise.resolve();
                },
            },
            thresholds: { ...DEFAULT_THRESHOLDS, cronFailures: 1, unreachableChecks: 1 },
        });
        await expect(service.recordJobRun({ job: 'relay-monitor', outcome: 'failed', at: 1 })).resolves.toEqual([
            expect.objectContaining({ rule: 'cron-job-failing', state: 'firing', subject: 'relay-monitor' }),
        ]);
        await expect(
            service.observe({
                at: 2,
                relays: [{ relay: 'relay-a', kind: 'down', reason: 'timeout' }],
                dashboardHealthy: true,
                counts: null,
            }),
        ).resolves.toEqual([expect.objectContaining({ rule: 'relay-unreachable', state: 'firing' })]);
        expect(Object.keys((stored as MonitorState | null)?.open ?? {})).toEqual([
            'cron-job-failing:relay-monitor',
            'relay-unreachable:relay-a',
        ]);
    });
});
