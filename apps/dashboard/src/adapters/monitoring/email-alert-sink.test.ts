import { describe, expect, it } from 'vitest';

import { createFakeEmailSender } from '../email/fake-email-sender';
import { createEmailAlertSink } from './email-alert-sink';

describe('createEmailAlertSink', () => {
    it('emails each alert in English, to ops or, for the abuse rules, to the abuse inbox', async () => {
        const email = createFakeEmailSender();
        const sink = createEmailAlertSink({ email, recipients: { ops: 'ops@ptbk.test', abuse: 'abuse@ptbk.test' } });
        await sink.send(
            { rule: 'public-face-mismatch', subject: 'e'.repeat(26), state: 'firing', at: 4, detail: {} },
            new AbortController().signal,
        );
        await sink.send(
            { rule: 'cron-job-failing', subject: 'relay-monitor', state: 'firing', at: 5, detail: { failedRuns: 3 } },
            new AbortController().signal,
        );
        expect(email.sent).toEqual([
            {
                template: 'ops-alert',
                to: 'abuse@ptbk.test',
                locale: 'en',
                rule: 'public-face-mismatch',
                subject: 'e'.repeat(26),
                state: 'firing',
                at: 4,
                detail: {},
            },
            {
                template: 'ops-alert',
                to: 'ops@ptbk.test',
                locale: 'en',
                rule: 'cron-job-failing',
                subject: 'relay-monitor',
                state: 'firing',
                at: 5,
                detail: { failedRuns: 3 },
            },
        ]);
    });
});
