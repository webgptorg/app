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

    it('queues one-off abuse alerts and tracks a check per subject over RPC (I-05)', async () => {
        const monitor = env.OPS_MONITOR.get(env.OPS_MONITOR.idFromName('abuse-test'));
        await monitor.raise([{ rule: 'ct-wildcard', subject: 'a'.repeat(64), state: 'firing', at: 1, detail: {} }]);
        await monitor.track('public-face-mismatch', [{ subject: 'e'.repeat(26), firing: true, detail: {} }], 2);
        await monitor.track('public-face-mismatch', [{ subject: 'e'.repeat(26), firing: true, detail: {} }], 3);
        await monitor.track('public-face-mismatch', [{ subject: 'e'.repeat(26), firing: null, detail: {} }], 4);
        expect((await monitor.pending()).map((pending) => [pending.alert.rule, pending.alert.state])).toEqual([
            ['ct-wildcard', 'firing'],
            ['public-face-mismatch', 'firing'],
        ]);
    });
});
