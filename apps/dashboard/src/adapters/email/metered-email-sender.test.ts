import { describe, expect, it } from 'vitest';

import { TEST_EMAIL } from '../../testing/email-sender-contract';
import { createFakeClock } from '../fake-clock';
import { createMemoryDashboardMetrics } from '../monitoring/memory-dashboard-metrics';
import { createFakeEmailSender } from './fake-email-sender';
import { createMeteredEmailSender } from './metered-email-sender';

describe('createMeteredEmailSender', () => {
    it('counts sent and failed emails by template and passes failures on', async () => {
        const metrics = createMemoryDashboardMetrics(createFakeClock(0));
        const sent = createMeteredEmailSender(createFakeEmailSender(), metrics);
        await sent.send(TEST_EMAIL, new AbortController().signal);
        const failing = createMeteredEmailSender({ send: () => Promise.reject(new Error('smtp')) }, metrics);
        await expect(failing.send(TEST_EMAIL, new AbortController().signal)).rejects.toThrow('smtp');
        expect(metrics.records.map((record) => record.metric)).toEqual([
            { name: 'ptbk_dashboard_emails_total', template: TEST_EMAIL.template, outcome: 'sent' },
            { name: 'ptbk_dashboard_emails_total', template: TEST_EMAIL.template, outcome: 'failed' },
        ]);
    });
});
