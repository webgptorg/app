import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import worker from '../../src/worker';

const ORIGIN = 'https://app.ptbk.test';
const OPS = 'ops@ptbk.test';

/** One run of the Worker's `scheduled` handler, as a Cron Trigger fires it. */
async function fire(cron = '* * * * *'): Promise<void> {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
}

/** The dev outbox of the same module instance the handler ran in. */
async function opsEmails(): Promise<{ template: string; subject: string; text: string }[]> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
        new Request(`${ORIGIN}/api/__dev/emails?to=${encodeURIComponent(OPS)}`, {
            headers: { 'CF-Connecting-IP': '198.19.0.2' },
        }),
        env,
        ctx,
    );
    return (await response.json<{ emails: { template: string; subject: string; text: string }[] }>()).emails;
}

// The scheduled dispatcher under workerd, with the monitoring job configured (vitest.config.ts): the dev relay
// `relay.ptbk.test` resolves nowhere, so every check of it fails, while the dashboard's own health check passes.
describe('the scheduled handler', () => {
    it('runs the monitoring job, and the second failed relay check emails one alert to ops', async () => {
        await fire();
        expect(await opsEmails()).toEqual([]);
        await fire();
        await fire();
        const emails = await opsEmails();
        expect(emails).toHaveLength(1);
        expect(emails[0]).toMatchObject({
            template: 'ops-alert',
            subject: '[ptbk ops] FIRING: relay-unreachable (relay)',
        });
        expect(emails[0]?.text).toContain('failedChecks: 2');
    });

    it('does nothing for a cron no job is registered for', async () => {
        await expect(fire('0 0 * * *')).resolves.toBeUndefined();
    });
});
