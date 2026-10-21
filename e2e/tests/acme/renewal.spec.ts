import { expect, test } from '../../src/fixtures.ts';
import { launchTrusting, loadInNewContext, pebbleRootPem } from '../../src/pebble.ts';
import { eventsAfter, serviceEvents } from '../../src/service-events.ts';
import { PEBBLE_VALIDITY_S } from '../../src/stack.ts';

interface StreamState {
    readonly ids: readonly number[];
    readonly receivedAtMs: readonly number[];
    readonly errors: number;
}

/*
 * Pebble issues 90-second certificates here, so the engine renews about once a minute (at two thirds of the
 * lifetime). A renewal must not disturb what is open: the SSE stream on the old certificate carries on without a
 * reconnect, while a new connection gets the new certificate.
 */
test('the engine renews while an SSE stream stays open; the stream survives, new connections get the new certificate', async ({
    playwright,
    compose,
    engineHost,
}) => {
    test.setTimeout(240_000);
    const pebble = await launchTrusting(playwright.chromium, await pebbleRootPem());
    try {
        const first = await loadInNewContext(pebble.browser, `https://${engineHost}/__spike/`);
        expect(first.response?.status()).toBe(200);
        const openedMs = Date.now();
        await first.page.evaluate(() => {
            const state = { ids: [] as number[], receivedAtMs: [] as number[], errors: 0 };
            (window as unknown as { sse: typeof state }).sse = state;
            const source = new EventSource('/__spike/sse?count=1000&intervalMs=250');
            source.onmessage = (event) => {
                state.ids.push(Number(event.lastEventId));
                state.receivedAtMs.push(Date.now());
            };
            source.onerror = () => {
                state.errors++;
            };
        });
        const stream = (): Promise<StreamState> =>
            first.page.evaluate(() => (window as unknown as { sse: StreamState }).sse);
        await expect.poll(async () => (await stream()).ids.length, { intervals: [100] }).toBeGreaterThan(0);

        let renewedMs = 0;
        await expect
            .poll(
                async () => {
                    const renewals = eventsAfter(
                        await serviceEvents(compose, 'mock-engine'),
                        'acme.certificate-issued',
                        openedMs,
                    );
                    renewedMs = renewals[0]?.timeMs ?? 0;
                    return renewals.length;
                },
                { intervals: [1_000], timeout: (PEBBLE_VALIDITY_S + 60) * 1_000, message: 'the engine renewed' },
            )
            .toBeGreaterThan(0);
        await expect
            .poll(async () => (await stream()).receivedAtMs.filter((atMs) => atMs > renewedMs + 1_000).length, {
                intervals: [250],
                timeout: 10_000,
            })
            .toBeGreaterThanOrEqual(4);

        const state = await stream();
        expect(state.errors, 'the stream never dropped or reconnected').toBe(0);
        expect(state.ids, 'every event arrived once, in order').toEqual(state.ids.map((_, index) => index + 1));
        expect(
            state.receivedAtMs.some((atMs) => atMs < renewedMs),
            'the stream was open before the renewal',
        ).toBe(true);

        const second = await loadInNewContext(pebble.browser, `https://${engineHost}/__spike/`);
        expect(second.response?.status()).toBe(200);
        expect(second.certificate.fingerprint256, 'a new connection gets the renewed certificate').not.toBe(
            first.certificate.fingerprint256,
        );
        expect(second.certificate.checkHost(engineHost)).toBe(engineHost);
    } finally {
        await pebble.close();
    }
});
