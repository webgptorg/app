import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../fake-clock';
import { createMemoryDashboardMetrics } from './memory-dashboard-metrics';

describe('createMemoryDashboardMetrics', () => {
    it('answers the counts of the window only, and stays bounded', async () => {
        const clock = createFakeClock(0);
        const metrics = createMemoryDashboardMetrics(clock);
        metrics.record({ name: 'ptbk_dashboard_heartbeats_total', outcome: 'bad-signature' });
        clock.advance(11 * 60_000);
        metrics.record({ name: 'ptbk_dashboard_heartbeats_total', outcome: 'accepted' });
        metrics.record({ name: 'ptbk_dashboard_heartbeats_total', outcome: 'replayed-seq' });
        metrics.record({ name: 'ptbk_dashboard_emails_total', template: 'signup-link', outcome: 'sent' });
        metrics.record({ name: 'ptbk_dashboard_emails_total', template: 'signup-link', outcome: 'failed' });
        metrics.record({ name: 'ptbk_dashboard_alarms_total', object: 'engine-status' });
        await expect(metrics.dashboardCounts(10, new AbortController().signal)).resolves.toEqual({
            heartbeatsAccepted: 1,
            heartbeatsRejected: 1,
            emailsSent: 1,
            emailsFailed: 1,
        });
        for (let index = 0; index < 10_001; index++)
            metrics.record({ name: 'ptbk_dashboard_alarms_total', object: 'engine-status' });
        expect(metrics.records).toHaveLength(10_000);
    });

    it('rejects an aborted query', async () => {
        const controller = new AbortController();
        controller.abort(new Error('stop'));
        await expect(
            createMemoryDashboardMetrics(createFakeClock(0)).dashboardCounts(10, controller.signal),
        ).rejects.toThrow('stop');
    });
});
