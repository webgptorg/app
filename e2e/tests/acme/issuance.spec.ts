import type { ComposeControl } from '../../src/compose.ts';
import { rawTlsAttempt } from '../../src/certificates.ts';
import { expect, test } from '../../src/fixtures.ts';
import { launchTrusting, loadInNewContext, pebbleRootPem } from '../../src/pebble.ts';
import type { ServiceEvent } from '../../src/service-events.ts';
import { eventsAfter, serviceEvents } from '../../src/service-events.ts';
import { HTTPS_PORT, RELAYS } from '../../src/stack.ts';

const ENGINE = 'mock-engine';

async function engineEvents(compose: ComposeControl, event: string, sinceMs = 0): Promise<readonly ServiceEvent[]> {
    return eventsAfter(await serviceEvents(compose, ENGINE), event, sinceMs);
}

/*
 * The spec's riskiest assumption (Residual risks 1): the engine gets its own certificate with TLS-ALPN-01 while it is
 * reachable only through the passthrough relay, and nobody touches DNS for it. Pebble resolves the engine hostname to
 * relay-a and validates there; relay-a routes the validation into the tunnel by SNI like any browser connection.
 */
test('a fresh mock engine gets a Pebble certificate through the relay, and a browser loads whoami with it', async ({
    playwright,
    compose,
    engineHost,
}) => {
    expect((await engineEvents(compose, 'acme.order-created')).length).toBeGreaterThan(0);
    expect(await engineEvents(compose, 'acme.challenge-valid')).toContainEqual(
        expect.objectContaining({ fields: expect.objectContaining({ hostname: engineHost }) }),
    );
    const issued = await engineEvents(compose, 'acme.certificate-issued');
    expect(issued.length).toBeGreaterThan(0);
    expect(issued[0]?.fields['notAfter']).toMatch(/^\d{4}-\d\d-\d\dT/);
    // The first issuance's timeline, from the engine's own events: what the spike doc reports.
    const firstReady = (await engineEvents(compose, 'tunnel.ready'))[0]?.timeMs ?? Number.NaN;
    const firstOrder = (await engineEvents(compose, 'acme.order-created'))[0]?.timeMs ?? Number.NaN;
    const firstValid = (await engineEvents(compose, 'acme.challenge-valid'))[0]?.timeMs ?? Number.NaN;
    const firstIssued = issued[0]?.timeMs ?? Number.NaN;
    const timeline = {
        tunnelReadyToOrderMs: firstOrder - firstReady,
        orderToChallengeValidMs: firstValid - firstOrder,
        challengeValidToIssuedMs: firstIssued - firstValid,
        failedAttemptsBefore: (await engineEvents(compose, 'acme.issue-failed', 0)).filter(
            (event) => event.timeMs < firstIssued,
        ).length,
    };
    console.log(`acme first issuance: ${JSON.stringify(timeline)}`);
    expect(timeline.orderToChallengeValidMs + timeline.challengeValidToIssuedMs).toBeLessThan(30_000);

    const pebble = await launchTrusting(playwright.chromium, await pebbleRootPem());
    try {
        const { response, certificate } = await loadInNewContext(
            pebble.browser,
            `https://${engineHost}/__spike/whoami`,
        );
        expect(response?.status()).toBe(200);
        expect(await response?.json()).toMatchObject({ hostname: engineHost, alpn: 'http/1.1', tlsVersion: 'TLSv1.3' });
        expect(certificate.checkHost(engineHost)).toBe(engineHost);
        expect(certificate.issuer).toContain('Pebble Intermediate CA');
    } finally {
        await pebble.close();
    }
});

test('the dev CA no longer vouches for the engine: a browser trusting only it is refused', async ({
    page,
    engineHost,
}) => {
    await expect(page.goto(`https://${engineHost}/__spike/whoami`)).rejects.toThrow(/ERR_CERT_AUTHORITY_INVALID/);
});

/*
 * Outside an issuance the engine never answers acme-tls/1: a CA (or anyone) asking for it gets the stream closed before
 * a single byte comes back, while browsers keep being served. The attempt is timed away from renewals, which run once
 * a minute in this scenario and are the only time a challenge is pending.
 */
test('an acme-tls/1 connection with no pending challenge is closed, and normal traffic is unaffected', async ({
    playwright,
    compose,
    engineHost,
}) => {
    test.setTimeout(120_000);
    await expect
        .poll(
            async () => {
                const latest = (await engineEvents(compose, 'acme.certificate-issued')).at(-1);
                return latest !== undefined && Date.now() - latest.timeMs < 30_000;
            },
            { intervals: [500], timeout: 90_000, message: 'a renewal just finished, so none is due for 30 s' },
        )
        .toBe(true);
    const startedMs = Date.now();
    const relayA = RELAYS[0];
    if (relayA === undefined) throw new Error('the stack has no relay');
    const attempt = await rawTlsAttempt({
        address: relayA.ip,
        port: HTTPS_PORT,
        servername: engineHost,
        alpn: ['acme-tls/1'],
    });
    expect(attempt).toEqual({ kind: 'closed', bytesReceived: 0 });
    await expect
        .poll(
            async () =>
                (await engineEvents(compose, 'tls.hello-rejected', startedMs)).map((event) => event.fields['reason']),
            {
                intervals: [200],
                timeout: 10_000,
            },
        )
        .toContain('no-pending-challenge');
    expect(await engineEvents(compose, 'acme.order-created', startedMs), 'no issuance overlapped the attempt').toEqual(
        [],
    );

    const pebble = await launchTrusting(playwright.chromium, await pebbleRootPem());
    try {
        const { response } = await loadInNewContext(pebble.browser, `https://${engineHost}/__spike/`);
        expect(response?.status()).toBe(200);
    } finally {
        await pebble.close();
    }
});
