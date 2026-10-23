import { expect, test } from '../../src/fixtures.ts';
import { fetchText } from '../../src/probe.ts';
import { DASHBOARD_ORIGIN, RELAYS } from '../../src/stack.ts';

const OPS = 'ops@ptbk.test';
const RELAY = RELAYS[0];
const TIMEOUT_MS = 30_000;

interface OutboxEmail {
    readonly template: string;
    readonly subject: string;
}

/**
 * One run of the Worker's Cron Trigger, through the dev server's trigger endpoint (workerd's --test-scheduled), as
 * Cloudflare fires it every minute in production. Resolves once the run is over.
 */
async function fireCron(ca: string): Promise<void> {
    await fetchText(
        `${DASHBOARD_ORIGIN}/cdn-cgi/local/scheduled?cron=${encodeURIComponent('* * * * *')}`,
        ca,
        TIMEOUT_MS,
    );
}

async function opsAlerts(ca: string): Promise<readonly string[]> {
    const body = await fetchText(`${DASHBOARD_ORIGIN}/api/__dev/emails?to=${encodeURIComponent(OPS)}`, ca, TIMEOUT_MS);
    const { emails } = JSON.parse(body) as { emails: readonly OutboxEmail[] };
    return emails.filter((email) => email.template === 'ops-alert').map((email) => email.subject);
}

/*
 * I-04's acceptance in the stack: both relays expose metrics to the dashboard only with their token; the monitoring
 * job sees them up; stopping relay-a raises the relay-unreachable alert on the second failed check (to the ops address,
 * in the fake outbox), and starting it again clears the alert on the next check.
 */
test('stopping a relay raises the unreachable alert, and restarting it clears the alert', async ({
    compose,
    caCertificatePem,
}) => {
    if (RELAY === undefined) throw new Error('the stack has no relay');
    test.setTimeout(240_000);
    const relayName = RELAY.hostname.split('.')[0] ?? RELAY.hostname;
    const firing = `[ptbk ops] FIRING: relay-unreachable (${relayName})`;
    const resolved = `[ptbk ops] resolved: relay-unreachable (${relayName})`;

    await fireCron(caCertificatePem);
    await fireCron(caCertificatePem);
    expect(await opsAlerts(caCertificatePem), 'both relays answer their scrape').toEqual([]);

    await compose.stop(RELAY.service);
    try {
        await fireCron(caCertificatePem);
        expect(await opsAlerts(caCertificatePem), 'one failed check is no alert yet').toEqual([]);
        await fireCron(caCertificatePem);
        expect(await opsAlerts(caCertificatePem)).toEqual([firing]);
        await fireCron(caCertificatePem);
        expect(await opsAlerts(caCertificatePem), 'the alert is sent once').toEqual([firing]);
    } finally {
        await compose.start(RELAY.service);
    }
    await expect.poll(() => compose.health(RELAY.service), { intervals: [200], timeout: 60_000 }).toBe('healthy');
    await fireCron(caCertificatePem);
    expect(await opsAlerts(caCertificatePem)).toEqual([firing, resolved]);
});
