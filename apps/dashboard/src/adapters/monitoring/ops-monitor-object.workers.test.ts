import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { OPS_MONITOR_NAME } from './durable-object-monitor-store';

const stub = () => env.OPS_MONITOR.get(env.OPS_MONITOR.idFromName(OPS_MONITOR_NAME));

describe('OpsMonitor', () => {
    it('keeps a job failure streak across calls and answers the alert at the third failure', async () => {
        const monitor = stub();
        expect(await monitor.recordJobRun({ job: 'relay-monitor', outcome: 'failed', at: 1 })).toEqual([]);
        expect(await monitor.recordJobRun({ job: 'relay-monitor', outcome: 'failed', at: 2 })).toEqual([]);
        expect(await monitor.recordJobRun({ job: 'relay-monitor', outcome: 'failed', at: 3 })).toEqual([
            { rule: 'cron-job-failing', subject: 'relay-monitor', state: 'firing', at: 3, detail: { failedRuns: 3 } },
        ]);
        expect(await monitor.recordJobRun({ job: 'relay-monitor', outcome: 'ok', at: 4 })).toMatchObject([
            { rule: 'cron-job-failing', state: 'resolved' },
        ]);
    });

    it('evaluates relay checks across runs, and starts over from a state it cannot read', async () => {
        const monitor = stub();
        const down = {
            at: 1,
            relays: [{ relay: 'relay-a', kind: 'down', reason: 'tls' }],
            dashboardHealthy: true,
            counts: null,
        } as const;
        expect(await monitor.observe(down)).toEqual([]);
        expect(await monitor.observe({ ...down, at: 2 })).toMatchObject([
            { rule: 'relay-unreachable', state: 'firing' },
        ]);
        await runInDurableObject(monitor, async (_, state) => {
            await state.storage.put('state', { v: 99 });
        });
        expect(await monitor.observe({ ...down, at: 3 })).toEqual([]);
    });
});
