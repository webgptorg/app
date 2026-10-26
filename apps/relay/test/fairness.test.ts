import { performance } from 'node:perf_hooks';
import type { Readable } from 'node:stream';

import type { RelayMessage, TunnelChallenge } from '@ptbk/protocol';
import { CLOSE_CODE, TUNNEL_CLOSE_CODE } from '@ptbk/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { captureClientHello, rawClient } from '../src/testing/client-hello';
import type { RawClient } from '../src/testing/client-hello';
import type { TestEngineClient } from '../src/testing/engine-client';
import type { EngineStreams } from '../src/testing/engine-streams';
import { serveEngineStreams } from '../src/testing/engine-streams';
import type { TestEngine } from '../src/testing/engines';
import { createTestEngine } from '../src/testing/engines';
import type { RelayHarness } from '../src/testing/relay-harness';
import { startHarness } from '../src/testing/relay-harness';

const LOAD_TEST_MS = 120_000;
/** Connections per measurement; the median of these is compared. */
const SAMPLES = 30;
const CHUNK = Buffer.alloc(16 * 1024, 0x61);

/**
 * Per-engine limits small enough that a flood on one engine runs into them within the test, on real time so their
 * buckets refill as in production. The browser listener's per-IP limits are lifted: every test socket comes from
 * 127.0.0.1, and what is proven here is the per-engine share, not the per-source one (the listener tests cover those).
 * The tunnel's per-IP limits stay at their defaults, so a hostile engine's reconnects are paced as in production.
 */
const ENV = {
    RELAY_MAX_STREAMS_PER_ENGINE: '32',
    RELAY_NEW_STREAMS_PER_ENGINE_PER_S: '50',
    RELAY_ENGINE_BANDWIDTH_BYTES_PER_S: '2000000',
    RELAY_TUNNEL_FRAMES_PER_S: '2000',
    RELAY_MAX_CONNECTIONS_PER_IP: '100000',
    RELAY_NEW_CONNECTIONS_PER_IP_PER_S: '100000',
} as const;

/**
 * `RELAY_NEW_CONNECTIONS_PER_IP_PER_S`'s default: the fastest one address reaches the tunnel endpoint in production.
 * The test lifts that limit for its browsers, so the hostile engine keeps to it itself after a refusal.
 */
const LISTENER_CONNECTIONS_PER_IP_PER_S = 50;
/**
 * Twice the engine's stream limit, with a pause before each retry: past its limits either way. The browsers run in the
 * relay's own process, so a bigger flood mostly measures the test's own CPU on a loaded machine, not the relay.
 */
const FLOOD_BROWSERS = 64;
const BROWSER_RETRY_MS = 250;
/** Spreads each measurement over the flood instead of one burst of connections. */
const SAMPLE_GAP_MS = 10;
/** Reserved type 5 with the ignorable flag, stream 1, one byte: the relay only parses and drops it. */
const IGNORABLE_FRAME = Uint8Array.of(0x85, 0, 0, 0, 1, 9);

interface Online {
    readonly engine: TestEngine;
    readonly client: TestEngineClient;
    readonly streams: EngineStreams;
}

function challengeOf(message: RelayMessage): TunnelChallenge {
    if (message.type !== 'challenge') throw new Error(`expected a challenge, got ${message.type}`);
    return message;
}

function readBytes(stream: Readable, bytes: number): Promise<void> {
    let total = 0;
    return new Promise((resolve) => {
        const onData = (chunk: Buffer): void => {
            total += chunk.length;
            if (total < bytes) return;
            stream.off('data', onData);
            resolve();
        };
        stream.on('data', onData);
    });
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls, because what the flood reaches shows only in counters; the test's timeout bounds the wait. */
async function until(condition: () => boolean): Promise<void> {
    while (!condition()) await delay(10);
}

function nextOrClosed(client: TestEngineClient): Promise<RelayMessage | null> {
    return Promise.race([client.nextMessage(), client.closed.then(() => null)]);
}

function median(values: readonly number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] as number;
}

/**
 * I-05: one engine flooded must not slow another engine's connections down by more than 2x. R-05 measures the
 * production values; this proves the mechanism, in process, with the relay and every client on one event loop.
 */
describe('fairness between engines on one relay', () => {
    let relay: RelayHarness | undefined;
    const sockets: RawClient[] = [];
    let flooding = false;
    // Read through a call: the attack loop awaits, and the flag changes meanwhile.
    const stillFlooding = (): boolean => flooding;

    afterEach(async () => {
        flooding = false;
        for (const client of sockets.splice(0)) client.socket.destroy();
        await relay?.close();
        relay = undefined;
    });

    async function online(harness: RelayHarness, seed: number): Promise<Online> {
        const engine = await createTestEngine(seed);
        harness.registry.set(engine.engineId, engine.entry);
        const client = harness.connect(engine);
        await client.authenticate(challengeOf(await client.nextMessage()));
        expect(await client.nextMessage()).toMatchObject({ type: 'ready' });
        return { engine, client, streams: serveEngineStreams(client.ws) };
    }

    /**
     * One browser connection to `target`, as a browser opens a TLS session: from the first byte of its ClientHello to
     * the first byte of the engine's answer. The engine answers every stream it is offered at once.
     */
    async function connectionLatency(harness: RelayHarness, target: Online, hello: Buffer): Promise<number> {
        const started = performance.now();
        const client = rawClient(harness.port);
        sockets.push(client);
        client.socket.write(hello);
        const stream = await target.streams.next();
        await readBytes(stream, hello.length);
        const answered = new Promise<void>((resolve) => {
            client.socket.once('data', () => {
                resolve();
            });
        });
        stream.write('x');
        await answered;
        const elapsed = performance.now() - started;
        stream.closeWith(CLOSE_CODE.NORMAL);
        client.socket.destroy();
        return elapsed;
    }

    async function measure(harness: RelayHarness, target: Online, hello: Buffer): Promise<number> {
        const samples: number[] = [];
        for (let index = 0; index < SAMPLES; index++) {
            samples.push(await connectionLatency(harness, target, hello));
            await delay(SAMPLE_GAP_MS);
        }
        return median(samples);
    }

    /** Measured once warm, so a cold first run (JIT, TLS session setup) does not inflate the bound. */
    async function measureBaseline(harness: RelayHarness, target: Online, hello: Buffer): Promise<number> {
        await measure(harness, target, hello);
        return measure(harness, target, hello);
    }

    /**
     * Browsers that keep coming back to `target`, many more than its limits admit: each sends its ClientHello and then
     * data as fast as the socket takes it; the engine answers every stream with data of its own. A refused browser
     * retries after `BROWSER_RETRY_MS`, as browsers do.
     */
    function floodBrowsers(harness: RelayHarness, target: Online, hello: Buffer, browsers: number): void {
        flooding = true;
        void (async () => {
            for (;;) {
                const stream = await target.streams.next();
                stream.resume();
                const pump = (): void => {
                    while (flooding && stream.write(CHUNK));
                };
                stream.on('drain', pump);
                pump();
            }
        })();
        const browser = (): void => {
            if (!flooding) return;
            const client = rawClient(harness.port);
            sockets.push(client);
            client.socket.resume();
            client.socket.write(hello);
            const pump = (): void => {
                while (flooding && !client.socket.destroyed && client.socket.write(CHUNK));
            };
            client.socket.on('drain', pump);
            pump();
            void client.closed.then(() => {
                setTimeout(browser, BROWSER_RETRY_MS);
            });
        };
        for (let index = 0; index < browsers; index++) browser();
    }

    it(
        'keeps a quiet engine’s connection latency within 2x while another is flooded with browsers and data',
        async () => {
            const harness = await start();
            const flooded = await online(harness, 301);
            const quiet = await online(harness, 302);
            const floodedHello = await captureClientHello(flooded.engine.defaultHostname);
            const quietHello = await captureClientHello(quiet.engine.defaultHostname);

            const baseline = await measureBaseline(harness, quiet, quietHello);
            floodBrowsers(harness, flooded, floodedHello, FLOOD_BROWSERS);
            // Measured once the flood runs into the engine's limits.
            await until(() => {
                const refusals = harness.listener.browser.refusals();
                return refusals['engine-streams'] + refusals['engine-rate'] > 0;
            });
            const underFlood = await measure(harness, quiet, quietHello);

            expect(
                underFlood,
                `baseline ${baseline.toFixed(2)} ms, under flood ${underFlood.toFixed(2)} ms`,
            ).toBeLessThanOrEqual(2 * baseline);
        },
        LOAD_TEST_MS,
    );

    /**
     * Ignorable frames as fast as the socket takes them, until the relay cuts the tunnel: its close code, or `null` if
     * the flood was called off first.
     */
    async function floodFrames(client: TestEngineClient): Promise<number | null> {
        while (stillFlooding() && client.ws.readyState === client.ws.OPEN) {
            for (let sent = 0; sent < 500; sent++) client.ws.send(IGNORABLE_FRAME);
            await new Promise((resolve) => setImmediate(resolve));
        }
        if (stillFlooding()) return (await client.closed).code;
        client.ws.terminate();
        return null;
    }

    it(
        'cuts a hostile engine at its frame budget on every reconnect, paces its reconnects, and keeps another within 2x',
        async () => {
            const harness = await start();
            const quiet = await online(harness, 303);
            const hostile = await createTestEngine(304);
            harness.registry.set(hostile.engineId, hostile.entry);
            const quietHello = await captureClientHello(quiet.engine.defaultHostname);
            const baseline = await measureBaseline(harness, quiet, quietHello);

            flooding = true;
            const cuts: number[] = [];
            let refused = 0;
            const attack = async (): Promise<void> => {
                while (stillFlooding()) {
                    const client = harness.connect(hostile);
                    const first = await nextOrClosed(client);
                    if (first?.type === 'challenge') {
                        await client.authenticate(first);
                        if ((await nextOrClosed(client))?.type === 'ready') {
                            const code = await floodFrames(client);
                            if (code !== null) cuts.push(code);
                        }
                    } else if (first?.type === 'reject') {
                        refused++;
                    }
                    client.ws.terminate();
                    await delay(1000 / LISTENER_CONNECTIONS_PER_IP_PER_S);
                }
            };
            const attacking = attack();
            // Once its handshake burst is spent, so the measurement sees the reconnects as they are paced from then on.
            await until(() => refused > 0);
            const underFlood = await measure(harness, quiet, quietHello);
            flooding = false;
            await attacking;

            expect(cuts.length).toBeGreaterThan(1);
            expect(new Set(cuts)).toEqual(new Set([TUNNEL_CLOSE_CODE.FRAME_BUDGET]));
            expect(refused).toBeGreaterThan(0);
            expect(harness.listener.sessions.byEngine(quiet.engine.engineId)).toBeDefined();
            expect(
                underFlood,
                `baseline ${baseline.toFixed(2)} ms, under flood ${underFlood.toFixed(2)} ms`,
            ).toBeLessThanOrEqual(2 * baseline);
        },
        LOAD_TEST_MS,
    );

    async function start(): Promise<RelayHarness> {
        relay = await startHarness({ env: ENV, realTime: true });
        return relay;
    }
});
