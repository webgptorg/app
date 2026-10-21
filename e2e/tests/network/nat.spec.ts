import { expect, test } from '../../src/fixtures.ts';
import { eventsAfter, serviceEvents, tcpAttemptFrom } from '../../src/service-events.ts';
import { ENGINE_HOST, ENGINE_HOST_PORTS, GATEWAY, RELAYS } from '../../src/stack.ts';
import { LISTENER_BANNER, tcpAttempt } from '../../src/tcp-check.ts';

const ATTEMPT_TIMEOUT_MS = 3_000;
/** The engine host's open ports, plus the usual suspects of a home router or a forgotten service. */
const PROBED_PORTS = [...new Set([...ENGINE_HOST_PORTS, 22, 80, 3128, 4480, 8443])];

test('the engine page loads through the relays while the engine sits behind NAT', async ({
    page,
    engineId,
    spikeUrl,
    compose,
}) => {
    const response = await page.goto(spikeUrl);
    expect(response?.status()).toBe(200);
    await expect(page.locator('#engine-id')).toHaveText(engineId);

    // Every relay sees the engine's tunnel arrive from the gateway's address, never from the engine's own.
    for (const relay of RELAYS) {
        const connected = eventsAfter(await serviceEvents(compose, relay.service), 'tunnel.connected', 0, { engineId });
        expect(connected.length, relay.hostname).toBeGreaterThan(0);
        expect(connected.at(-1)?.fields['engineIp'], relay.hostname).toBe(GATEWAY.publicIp);
    }
});

test('nothing outside the engine LAN can open a connection to the engine host, though its ports are open', async ({
    compose,
}) => {
    test.setTimeout(60_000);
    // Positive control: on the LAN, the engine host answers on every one of its ports.
    for (const port of ENGINE_HOST_PORTS) {
        const fromLan = await tcpAttemptFrom(
            compose,
            GATEWAY.service,
            { host: ENGINE_HOST.ip, port },
            ATTEMPT_TIMEOUT_MS,
        );
        expect(fromLan.outcome, `gateway -> engine host:${String(port)}`).toBe('connected');
        expect(fromLan.banner).toContain(LISTENER_BANNER);
    }

    // From the browser's network: neither the engine's private address nor the address it is NATed behind lets a
    // connection through, on any of these ports. The gateway forwards nothing that starts outside.
    const targets = [ENGINE_HOST.ip, GATEWAY.publicIp].flatMap((host) => PROBED_PORTS.map((port) => ({ host, port })));
    const attempts = await Promise.all(
        targets.map(async (target) => ({
            target: `${target.host}:${String(target.port)}`,
            outcome: (await tcpAttempt(target.host, target.port, ATTEMPT_TIMEOUT_MS)).outcome,
        })),
    );
    expect(attempts.filter((attempt) => attempt.outcome === 'connected')).toEqual([]);
});
