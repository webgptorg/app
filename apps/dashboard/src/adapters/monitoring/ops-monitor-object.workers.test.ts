import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { OPS_MONITOR_NAME } from './durable-object-monitor-store';

const stub = () => env.OPS_MONITOR.get(env.OPS_MONITOR.idFromName(OPS_MONITOR_NAME));

describe('OpsMonitor', () => {
    it('keeps a job failure streak across calls and queues the alert at the third failure until it is delivered', async () => {
        const monitor = stub();
        for (const at of [1, 2]) await monitor.recordJobRun({ job: 'relay-monitor', outcome: 'failed', at });
        expect(await monitor.pending()).toEqual([]);
        await monitor.recordJobRun({ job: 'relay-monitor', outcome: 'failed', at: 3 });
        const [pending] = await monitor.pending();
        expect(pending).toMatchObject({
            attempts: 0,
            alert: {
                rule: 'cron-job-failing',
                subject: 'relay-monitor',
                state: 'firing',
                at: 3,
                detail: { failedRuns: 3 },
            },
        });
        expect(await monitor.settle([{ id: pending?.id ?? '', delivered: false }])).toEqual([]);
        expect(await monitor.pending()).toMatchObject([{ attempts: 1 }]);
        await monitor.settle([{ id: pending?.id ?? '', delivered: true }]);
        expect(await monitor.pending()).toEqual([]);
    });

    it('evaluates relay checks across runs, and starts over from a state it cannot read', async () => {
        const monitor = stub();
        const down = {
            at: 1,
            relays: [{ relay: 'relay-a', kind: 'down', reason: 'tls' }],
            dashboardHealthy: true,
            counts: null,
        } as const;
        await monitor.observe(down);
        expect(await monitor.pending()).toEqual([]);
        await monitor.observe({ ...down, at: 2 });
        expect(await monitor.pending()).toMatchObject([{ alert: { rule: 'relay-unreachable', state: 'firing' } }]);
        await runInDurableObject(monitor, async (_, state) => {
            await state.storage.put('state', { v: 99 });
        });
        expect(await monitor.pending()).toEqual([]);
    });
});
