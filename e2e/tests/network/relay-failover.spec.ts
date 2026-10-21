import type { Browser } from '@playwright/test';

import type { ComposeControl } from '../../src/compose.ts';
import { expect, test } from '../../src/fixtures.ts';
import { everyRelayServesEngine, launchPreferringRelay } from '../../src/relay-order.ts';
import type { RelayNode } from '../../src/stack.ts';
import { HTTPS_PORT, RELAYS } from '../../src/stack.ts';
import { tcpAttempt } from '../../src/tcp-check.ts';

const FAILOVER_LIMIT_MS = 15_000;
const NETWORK = 'stack';

/**
 * How a relay goes away. `kill`: the relay process is gone while its host stays up, so its port refuses connections
 * (the address belongs to relay-<x>-net, which outlives the relay). `blackhole`: the relay is frozen (`docker pause`)
 * and its address goes dark (its namespace is taken off the network), so nothing answers at all, not even a reset.
 * A pause alone is not a blackhole: the frozen relay's kernel still completes TCP handshakes, the browser's
 * connection is accepted and then stalls in TLS, and Chromium does not try another address after that.
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

async function waitUntilEveryRelayServesTheEngine(engineHost: string, caCertificatePem: string): Promise<void> {
    await expect
        .poll(() => everyRelayServesEngine(engineHost, caCertificatePem), { intervals: [100], timeout: 90_000 })
        .toBe(true);
}

for (const relay of RELAYS) {
    for (const outage of OUTAGES) {
        test(`with ${relay.service} down (${outage.name}), a fresh browser loads the engine through the other relay`, async ({
            playwright,
            compose,
            engineHost,
            engineUrl,
            engineId,
            caCertificatePem,
        }) => {
            test.setTimeout(180_000);
            await waitUntilEveryRelayServesTheEngine(engineHost, caCertificatePem);
            const survivor = otherRelay(relay);
            let browser: Browser | undefined;
            let restore: (() => Promise<void>) | undefined;
            try {
                browser = await launchPreferringRelay(playwright.chromium, engineHost, relay);

                // Positive control: with both relays up, this browser goes to the relay about to fail.
                const before = await browser.newContext();
                const first = await (await before.newPage()).goto(engineUrl);
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
                const response = await page.goto(engineUrl, { timeout: 60_000 });
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
                await waitUntilEveryRelayServesTheEngine(engineHost, caCertificatePem);
            }
        });
    }
}
