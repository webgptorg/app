import { describe, expect, it } from 'vitest';

import { createFakeEmailSender } from '../email/fake-email-sender';
import { createEmailAlertSink } from './email-alert-sink';

describe('createEmailAlertSink', () => {
    it('emails each alert to the ops address in English', async () => {
        const email = createFakeEmailSender();
        const sink = createEmailAlertSink({ email, to: 'ops@ptbk.test' });
        await sink.send(
            { rule: 'cron-job-failing', subject: 'relay-monitor', state: 'firing', at: 5, detail: { failedRuns: 3 } },
            new AbortController().signal,
        );
        expect(email.sent).toEqual([
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
