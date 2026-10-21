import { rawTlsAttempt } from '../../src/certificates.ts';
import { expect, test } from '../../src/fixtures.ts';
import { everyRelayServesEngine } from '../../src/relay-order.ts';
import { eventsAfter, serviceEvents, tcpAttemptFrom } from '../../src/service-events.ts';
import { CONNECT_PROXY, ENGINE_HOST, HTTPS_PORT, RELAYS } from '../../src/stack.ts';

test('the engine reaches both relays only through the CONNECT proxy, and the page loads', async ({
    page,
    engineId,
    engineUrl,
    compose,
}) => {
    const response = await page.goto(engineUrl);
    expect(response?.status()).toBe(200);
    await expect(page.locator('#engine-id')).toHaveText(engineId);

    const proxyLog = await compose.logs(CONNECT_PROXY.service);
    for (const relay of RELAYS) {
        expect(proxyLog, `the proxy tunnelled to ${relay.hostname}`).toContain(
            `CONNECT ${relay.hostname}:${String(HTTPS_PORT)}`,
        );
        const connected = eventsAfter(await serviceEvents(compose, relay.service), 'tunnel.connected', 0, { engineId });
        expect(connected.at(-1)?.fields['engineIp'], `${relay.hostname} sees the proxy`).toBe(CONNECT_PROXY.publicIp);
    }
    // And not around it: the gateway forwards nothing in this scenario.
    const relayA = RELAYS[0];
    if (relayA === undefined) throw new Error('the stack has no relay');
    const direct = await tcpAttemptFrom(compose, ENGINE_HOST.service, { host: relayA.ip, port: HTTPS_PORT }, 3_000);
    expect(direct.outcome, 'engine -> relay-a:443 without the proxy').toBe('timeout');
});

test('with the proxy stopped, the tunnels drop and no relay routes the engine', async ({
    compose,
    engineId,
    engineHost,
    caCertificatePem,
}) => {
    test.setTimeout(120_000);
    const stoppedAt = Date.now();
    await compose.stop(CONNECT_PROXY.service);
    try {
        for (const relay of RELAYS) {
            await expect
                .poll(
                    async () =>
                        eventsAfter(await serviceEvents(compose, relay.service), 'tunnel.disconnected', stoppedAt, {
                            engineId,
                        }).length,
                    { intervals: [100], timeout: 30_000, message: `${relay.hostname} lost the tunnel` },
                )
                .toBeGreaterThan(0);
            // A relay without the engine's tunnel closes the browser's connection without a byte.
            expect(
                await rawTlsAttempt({ address: relay.ip, port: HTTPS_PORT, servername: engineHost }),
                relay.hostname,
            ).toEqual({ kind: 'closed', bytesReceived: 0 });
        }
    } finally {
        await compose.start(CONNECT_PROXY.service);
        await expect
            .poll(() => everyRelayServesEngine(engineHost, caCertificatePem), { intervals: [100], timeout: 60_000 })
            .toBe(true);
    }
});
