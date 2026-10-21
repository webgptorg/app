import { expect, test } from '../../src/fixtures.ts';
import { relayServesEngine } from '../../src/relay-order.ts';
import type { ServiceEvent } from '../../src/service-events.ts';
import { eventsAfter, serviceEvents } from '../../src/service-events.ts';
import { RELAYS } from '../../src/stack.ts';

const RUNS = 3;
const RECONNECT_LIMIT_MS = 10_000;
const RELAY = RELAYS[0];

function readyFor(events: readonly ServiceEvent[], hostname: string, sinceMs: number): ServiceEvent | undefined {
    return eventsAfter(events, 'tunnel.ready', sinceMs).find((event) =>
        String(event.fields['relay']).includes(hostname),
    );
}

/*
 * Measured from the relay's own `relay.started` event, which it logs once it listens again, to the mock engine's
 * `tunnel.ready` for that relay. The healthcheck can only pass after the relay listens, so this interval is never
 * shorter than the one from "healthy again", and holding it under the limit holds the brief's under it too.
 */
test(`after docker compose restart, the engine's tunnel to ${RELAY?.service ?? ''} is back within 10 s, ${String(RUNS)} times`, async ({
    compose,
    engineHost,
    caCertificatePem,
}) => {
    if (RELAY === undefined) throw new Error('the stack has no relay');
    test.setTimeout(240_000);
    const times: number[] = [];
    for (let run = 1; run <= RUNS; run++) {
        await expect
            .poll(() => relayServesEngine(RELAY, engineHost, caCertificatePem), { intervals: [100], timeout: 60_000 })
            .toBe(true);
        const restartedAt = Date.now();
        await compose.restart(RELAY.service);
        await expect.poll(() => compose.health(RELAY.service), { intervals: [100], timeout: 60_000 }).toBe('healthy');

        let interval: number | undefined;
        await expect
            .poll(
                async () => {
                    const started = eventsAfter(
                        await serviceEvents(compose, RELAY.service),
                        'relay.started',
                        restartedAt,
                    ).at(0);
                    if (started === undefined) return false;
                    const ready = readyFor(await serviceEvents(compose, 'mock-engine'), RELAY.hostname, started.timeMs);
                    if (ready === undefined) return false;
                    interval = ready.timeMs - started.timeMs;
                    return true;
                },
                { intervals: [100], timeout: 60_000, message: 'the engine reports the tunnel ready again' },
            )
            .toBe(true);
        if (interval === undefined) throw new Error('no reconnect time');
        times.push(interval);
        console.log(`relay restart ${String(run)}: tunnel ready ${String(interval)} ms after ${RELAY.service} started`);
        test.info().annotations.push({ type: 'reconnect', description: `run ${String(run)}: ${String(interval)} ms` });
        expect(await relayServesEngine(RELAY, engineHost, caCertificatePem), 'the engine is served through it').toBe(
            true,
        );
    }
    expect(times).toHaveLength(RUNS);
    for (const time of times) expect(time).toBeLessThan(RECONNECT_LIMIT_MS);
});
