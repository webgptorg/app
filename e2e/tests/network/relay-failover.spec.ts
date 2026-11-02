import type { Browser } from '@playwright/test';

import type { ComposeControl } from '../../src/compose.ts';
import { expect, test } from '../../src/fixtures.ts';
import { addressesListedFor, everyRelayServesEngine, launchPreferringRelay } from '../../src/relay-order.ts';
import { eventsAfter, serviceEvents } from '../../src/service-events.ts';
import type { RelayNode } from '../../src/stack.ts';
import { HTTPS_PORT, RELAYS, RELAY_DNS } from '../../src/stack.ts';
import { tcpAttempt } from '../../src/tcp-check.ts';

const FAILOVER_LIMIT_MS = 15_000;
const NETWORK = 'stack';

/**
 * How a relay goes away. `kill`: the relay process is gone while its host stays up, so its port refuses connections
 * (the address belongs to relay-<x>-net, which outlives the relay). `blackhole`: the relay is frozen (`docker pause`)
 * and its address goes dark (its namespace is taken off the network), so nothing answers at all, not even a reset.
 * A pause alone is not a blackhole: the frozen relay's kernel still completes TCP handshakes, the browser's
 * connection is accepted and then stalls in TLS, and Chromium does not try another address after that (the hung-relay
 * test below).
 */
interface Outage {
    readonly name: 'kill' | 'blackhole';
    /** What a plain TCP attempt to the relay's port sees during the outage. */
    readonly expected: readonly string[];
    start(compose: ComposeControl, relay: RelayNode): Promise<() => Promise<void>>;
}

const OUTAGES: readonly Outage[] = [
    {
        name: 'kill',
        expected: ['refused'],
        async start(compose, relay) {
            await compose.kill(relay.service);
            return () => compose.start(relay.service);
        },
    },
    {
        name: 'blackhole',
        expected: ['timeout', 'unreachable'],
        async start(compose, relay) {
            await compose.pause(relay.service);
            const holder = `${relay.service}-net`;
            const address = await compose.disconnectNetwork(holder, NETWORK);
            return async () => {
                await compose.connectNetwork(holder, NETWORK, address);
                await compose.unpause(relay.service);
            };
        },
    },
];

function otherRelay(relay: RelayNode): RelayNode {
    const other = RELAYS.find((candidate) => candidate.service !== relay.service);
    if (other === undefined) throw new Error('the stack has a single relay');
    return other;
}

const ALL_RELAY_IPS = RELAYS.map((relay) => relay.ip);

/**
 * How long DNS must keep listing every relay before an outage counts as over. A relay can serve again while the checker
 * has not noticed it was gone: a check that started during the outage fails up to `timeoutMs` later, the relay then
 * leaves DNS, and CoreDNS loads that on its next reload. Seen on CI: the wait passed, 20 ms later the alert said relay-a
 * left, and the next test's browser found only the relay it was about to kill. One more interval as margin on a slow host.
 */
const COREDNS_RELOAD_MS = 1_000;
const DNS_SETTLE_MS = RELAY_DNS.timeoutMs + COREDNS_RELOAD_MS + RELAY_DNS.intervalMs + 1_000;

async function dnsListsEveryRelay(): Promise<boolean> {
    const listings = await Promise.all(
        RELAYS.map(async (relay) => {
            const expected = [relay.ip, ...ALL_RELAY_IPS.filter((ip) => ip !== relay.ip)];
            return (await addressesListedFor(relay)).join() === expected.join();
        }),
    );
    return listings.every(Boolean);
}

/** Every relay routes the engine and has stayed in the engine domain's DNS, first in its name, for `DNS_SETTLE_MS`. */
async function waitUntilEveryRelayIsBack(engineHost: string, caCertificatePem: string): Promise<void> {
    let settlingSince: number | null = null;
    await expect
        .poll(
            async () => {
                const back =
                    (await everyRelayServesEngine(engineHost, caCertificatePem)) && (await dnsListsEveryRelay());
                settlingSince = back ? (settlingSince ?? Date.now()) : null;
                return settlingSince !== null && Date.now() - settlingSince >= DNS_SETTLE_MS;
            },
            { intervals: [100], timeout: 90_000, message: 'every relay serves and DNS keeps listing it' },
        )
        .toBe(true);
}

for (const relay of RELAYS) {
    for (const outage of OUTAGES) {
        test(`with ${relay.service} down (${outage.name}), a fresh browser loads the engine through the other relay`, async ({
            playwright,
            compose,
            engineHost,
            spikeUrl,
            engineId,
            caCertificatePem,
        }) => {
            test.setTimeout(180_000);
            await waitUntilEveryRelayIsBack(engineHost, caCertificatePem);
            const survivor = otherRelay(relay);
            let browser: Browser | undefined;
            let restore: (() => Promise<void>) | undefined;
            try {
                browser = await launchPreferringRelay(playwright.chromium, engineHost, relay);

                // Positive control: with both relays up, this browser goes to the relay about to fail.
                const before = await browser.newContext();
                const first = await (await before.newPage()).goto(spikeUrl);
                expect(first?.status()).toBe(200);
                expect((await first?.serverAddr())?.ipAddress, 'the browser tries this relay first').toBe(relay.ip);
                await before.close();

                restore = await outage.start(compose, relay);
                const attempt = await tcpAttempt(relay.ip, HTTPS_PORT, 2_000);
                expect(outage.expected, `a TCP attempt to ${relay.hostname} during the outage`).toContain(
                    attempt.outcome,
                );

                const context = await browser.newContext();
                const page = await context.newPage();
                const started = Date.now();
                const response = await page.goto(spikeUrl, { timeout: 60_000 });
                const elapsedMs = Date.now() - started;
                test.info().annotations.push({
                    type: 'failover',
                    description: `${relay.service} ${outage.name}: ${String(elapsedMs)} ms`,
                });
                console.log(`failover: ${relay.service} ${outage.name}, page loaded in ${String(elapsedMs)} ms`);

                expect(response?.status()).toBe(200);
                await expect(page.locator('#engine-id')).toHaveText(engineId);
                expect((await response?.serverAddr())?.ipAddress, 'served by the other relay').toBe(survivor.ip);
                expect(elapsedMs).toBeLessThan(FAILOVER_LIMIT_MS);
                await context.close();
            } finally {
                await browser?.close();
                await restore?.();
                await waitUntilEveryRelayIsBack(engineHost, caCertificatePem);
            }
        });
    }
}

/*
 * A relay that hangs while its kernel still accepts TCP (`docker pause` alone) is not failed over by Chromium: it tries
 * the engine's A records one after another and moves on only when a connect fails, and this connect succeeds and then
 * stalls in TLS (measured 2026-10-21: ERR_TIMED_OUT after 30,055 ms, the other relay never tried). Browsers cannot be
 * changed, so the engine domain's DNS drops such a relay (I-07): Cloudflare's load balancer in production, the
 * relay-dns stand-in here, which fails a relay whose /healthz handshake does not finish in time. A browser that looks
 * the engine up afterwards gets only the healthy relay. Counted from the moment the relay hung.
 */
test('a hung relay that still accepts TCP leaves DNS, and a fresh browser loads the engine through the other relay', async ({
    playwright,
    compose,
    engineHost,
    spikeUrl,
    engineId,
    caCertificatePem,
}) => {
    test.setTimeout(120_000);
    const relayA = RELAYS[0];
    if (relayA === undefined) throw new Error('the stack has no relay');
    const relayB = otherRelay(relayA);
    await waitUntilEveryRelayIsBack(engineHost, caCertificatePem);
    expect(await addressesListedFor(relayA), 'relay-a is listed first before the hang').toEqual(ALL_RELAY_IPS);

    let browser: Browser | undefined;
    let paused = false;
    try {
        await compose.pause(relayA.service);
        paused = true;
        const hungAt = Date.now();
        expect((await tcpAttempt(relayA.ip, HTTPS_PORT, 2_000)).outcome, 'the paused relay still accepts TCP').toBe(
            'connected',
        );

        await expect
            .poll(() => addressesListedFor(relayA), { intervals: [100], timeout: FAILOVER_LIMIT_MS })
            .toEqual([relayB.ip]);
        const droppedMs = Date.now() - hungAt;

        browser = await launchPreferringRelay(playwright.chromium, engineHost, relayA);
        const page = await (await browser.newContext()).newPage();
        const response = await page.goto(spikeUrl, { timeout: FAILOVER_LIMIT_MS });
        const elapsedMs = Date.now() - hungAt;
        test.info().annotations.push({
            type: 'failover',
            description: `${relayA.service} hung: out of DNS after ${String(droppedMs)} ms, page loaded ${String(elapsedMs)} ms after the hang`,
        });
        console.log(
            `failover: ${relayA.service} hung, out of DNS after ${String(droppedMs)} ms, page loaded ${String(elapsedMs)} ms after the hang`,
        );

        expect(response?.status()).toBe(200);
        await expect(page.locator('#engine-id')).toHaveText(engineId);
        expect((await response?.serverAddr())?.ipAddress, 'served by the other relay').toBe(relayB.ip);
        expect(elapsedMs).toBeLessThan(FAILOVER_LIMIT_MS);
        expect(
            eventsAfter(await serviceEvents(compose, RELAY_DNS.service), 'relay_dns.relay_left', hungAt, {
                relay: relayA.hostname,
            }),
            'the stand-in alerts once when relay-a leaves DNS',
        ).toHaveLength(1);

        const recoveredAt = Date.now();
        await compose.unpause(relayA.service);
        paused = false;
        await expect
            .poll(() => addressesListedFor(relayA), { intervals: [100], timeout: 30_000 })
            .toEqual(ALL_RELAY_IPS);
        expect(
            eventsAfter(await serviceEvents(compose, RELAY_DNS.service), 'relay_dns.relay_rejoined', recoveredAt, {
                relay: relayA.hostname,
            }),
            'and once when it rejoins',
        ).toHaveLength(1);
    } finally {
        await browser?.close();
        if (paused) await compose.unpause(relayA.service);
        await waitUntilEveryRelayIsBack(engineHost, caCertificatePem);
    }
});
