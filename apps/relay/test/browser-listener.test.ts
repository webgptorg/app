import { X509Certificate, createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { request } from 'node:https';
import type { Readable } from 'node:stream';
import { TLSSocket, connect as connectTls } from 'node:tls';

import type { Hostname, RelayMessage, TunnelChallenge } from '@ptbk/protocol';
import {
    CLOSE_CODE,
    Hostname as HostnameSchema,
    INITIAL_WINDOW_BYTES,
    MAX_FRAME_PAYLOAD_BYTES,
    expectedCnameTarget,
    parseClientHello,
} from '@ptbk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CLIENT_HELLO_MAX_BYTES } from '../src/adapters/tcp-listener';
import {
    SCHEDULER_SLICE_BYTES,
    TUNNEL_HIGH_WATER_BYTES,
    TUNNEL_LOW_WATER_BYTES,
} from '../src/domain/routing/stream-scheduler';
import type { RawClient } from '../src/testing/client-hello';
import { captureClientHello, rawClient } from '../src/testing/client-hello';
import type { TestEngineClient } from '../src/testing/engine-client';
import type { EngineStream, EngineStreamOptions, EngineStreams } from '../src/testing/engine-streams';
import { serveEngineStreams } from '../src/testing/engine-streams';
import type { TestEngine } from '../src/testing/engines';
import { ENGINE_DOMAIN, createTestEngine } from '../src/testing/engines';
import type { RelayHarness } from '../src/testing/relay-harness';
import { RELAY_ID, startHarness } from '../src/testing/relay-harness';
import { createTestCertificate } from '../src/testing/test-pki';

const MIB = 1024 * 1024;
/** High enough that the fake clock never has to refill the bandwidth budget. */
const UNTHROTTLED = { RELAY_ENGINE_BANDWIDTH_BYTES_PER_S: '1250000000' } as const;
/** Large enough that no loopback socket buffer (a few MB on Linux) can absorb it. */
const STALL_BYTES = 24 * MIB;
const SLOW_TEST_MS = 60_000;

const hellos = new Map<string, Promise<Buffer>>();
function clientHello(servername?: string, alpn?: readonly string[]): Promise<Buffer> {
    const key = `${servername ?? ''}|${alpn?.join(',') ?? ''}`;
    let hello = hellos.get(key);
    if (hello === undefined) {
        hello = captureClientHello(servername, alpn);
        hellos.set(key, hello);
    }
    return hello;
}

function challengeOf(message: RelayMessage): TunnelChallenge {
    if (message.type !== 'challenge') throw new Error(`expected a challenge, got ${message.type}`);
    return message;
}

/** Reads exactly `bytes` from `stream` (leaving anything after them unread), then pauses it. */
function readBytes(stream: Readable, bytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    return new Promise((resolve) => {
        const onData = (chunk: Buffer): void => {
            chunks.push(chunk);
            total += chunk.length;
            if (total < bytes) return;
            stream.off('data', onData);
            stream.pause();
            const all = Buffer.concat(chunks);
            if (all.length > bytes) stream.unshift(all.subarray(bytes));
            resolve(all.subarray(0, bytes));
        };
        stream.on('data', onData);
        stream.resume();
    });
}

/** SHA-256 of the next `bytes` read from `stream`, without keeping them. */
function digestOf(stream: Readable, bytes: number): Promise<string> {
    const hash = createHash('sha256');
    let total = 0;
    return new Promise((resolve) => {
        const onData = (chunk: Buffer): void => {
            hash.update(chunk);
            total += chunk.length;
            if (total < bytes) return;
            stream.off('data', onData);
            resolve(hash.digest('hex'));
        };
        stream.on('data', onData);
        stream.resume();
    });
}

/** For waits that move a lot of data or step the fake clock between polls. */
const PATIENTLY = { timeout: 20_000, interval: 5 } as const;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

interface OnlineEngine {
    readonly engine: TestEngine;
    readonly client: TestEngineClient;
    readonly streams: EngineStreams;
}

interface Piped {
    readonly browser: RawClient;
    readonly stream: EngineStream;
}

describe('browser listener over real sockets', () => {
    let relay: RelayHarness | undefined;
    const clients: RawClient[] = [];
    let stopSampling = (): void => undefined;

    afterEach(async () => {
        stopSampling();
        for (const client of clients.splice(0)) client.socket.destroy();
        await relay?.close();
        relay = undefined;
    });

    async function start(env: Readonly<Record<string, string>> = {}): Promise<RelayHarness> {
        relay = await startHarness({ env });
        return relay;
    }

    function browser(harness: RelayHarness): RawClient {
        const client = rawClient(harness.port);
        clients.push(client);
        return client;
    }

    async function online(
        harness: RelayHarness,
        seed: number,
        custom: readonly Hostname[] = [],
        options: EngineStreamOptions = {},
    ): Promise<OnlineEngine> {
        const engine = await createTestEngine(seed, custom);
        harness.registry.set(engine.engineId, engine.entry);
        const client = harness.connect(engine);
        await client.authenticate(challengeOf(await client.nextMessage()));
        expect(await client.nextMessage()).toMatchObject({ type: 'ready' });
        return { engine, client, streams: serveEngineStreams(client.ws, options) };
    }

    /** A browser connection routed to the engine, its ClientHello already read on the engine side. */
    async function pipe(harness: RelayHarness, target: OnlineEngine, hostname?: string): Promise<Piped> {
        const hello = await clientHello(hostname ?? target.engine.defaultHostname);
        const client = browser(harness);
        client.socket.write(hello);
        const stream = await target.streams.next();
        expect(await readBytes(stream, hello.length)).toEqual(hello);
        return { browser: client, stream };
    }

    /** Resolves once the listener holds `count` connections. */
    async function connectionsReach(harness: RelayHarness, count: number): Promise<void> {
        await vi.waitFor(() => {
            expect(harness.listener.browser.connections()).toBe(count);
        });
    }

    /** Samples `measure` every millisecond until the test ends; returns the largest value seen so far. */
    function sampleMax(measure: () => number): () => number {
        let max = measure();
        const timer = setInterval(() => {
            max = Math.max(max, measure());
        }, 1);
        stopSampling = () => {
            clearInterval(timer);
        };
        return () => Math.max(max, measure());
    }

    it(
        'relays TLS end to end, 10 MB each way intact, under a certificate only the engine holds',
        async () => {
            const harness = await start(UNTHROTTLED);
            const target = await online(harness, 120);
            // Generated after the relay started and handed only to the engine side below.
            const engineCertificate = createTestCertificate([target.engine.defaultHostname]);
            const marker = Buffer.from('ptbk-plaintext-marker');
            let plaintextSeen = false;
            target.streams.onPayload((payload) => {
                if (Buffer.from(payload).includes(marker)) plaintextSeen = true;
            });
            const payload = randomBytes(10 * MIB);
            for (let offset = 0; offset < payload.length; offset += 4096) marker.copy(payload, offset);

            const tlsBrowser = connectTls({
                host: '127.0.0.1',
                port: harness.port,
                servername: target.engine.defaultHostname,
                ca: engineCertificate.cert,
            });
            const stream = await target.streams.next();
            const engineTls = new TLSSocket(stream, { isServer: true, ...engineCertificate });
            engineTls.pipe(engineTls);
            await once(tlsBrowser, 'secureConnect');
            expect(tlsBrowser.getPeerX509Certificate()?.fingerprint256).toBe(
                new X509Certificate(engineCertificate.cert).fingerprint256,
            );
            expect(harness.certificate.cert).not.toBe(engineCertificate.cert);

            const echoed = digestOf(tlsBrowser, payload.length);
            tlsBrowser.write(payload);
            expect(await echoed).toBe(sha256(payload));
            expect(stream.received()).toBeGreaterThan(payload.length);
            expect(stream.sent()).toBeGreaterThan(payload.length);
            expect(plaintextSeen).toBe(false);
            const traffic = harness.listener.browser.traffic();
            expect(traffic).toEqual([
                expect.objectContaining({ engineId: target.engine.engineId, bytesIn: stream.received() }),
            ]);
            expect(JSON.stringify(harness.logger.entries)).not.toContain(target.engine.defaultHostname);
            tlsBrowser.destroy();
        },
        SLOW_TEST_MS,
    );

    it('routes a ClientHello that arrives in many small TCP chunks', async () => {
        const harness = await start();
        const target = await online(harness, 121);
        const hello = await clientHello(target.engine.defaultHostname);
        const client = browser(harness);
        await connectionsReach(harness, 2);
        const step = 32;
        for (let offset = 0; offset < hello.length; offset += step) {
            client.socket.write(hello.subarray(offset, offset + step));
            const buffered = Math.min(offset + step, hello.length);
            // The listener has read this chunk on its own before the next one is sent.
            if (buffered < hello.length) {
                await vi.waitFor(() => {
                    expect(harness.listener.browser.bufferedBytes()).toBe(buffered);
                }, PATIENTLY);
            }
        }
        const stream = await target.streams.next();
        expect(await readBytes(stream, hello.length)).toEqual(hello);
    });

    it('forwards the bytes that follow the ClientHello in the same chunk, then everything after', async () => {
        const harness = await start();
        const target = await online(harness, 122);
        const hello = await clientHello(target.engine.defaultHostname);
        const early = Buffer.from('early application bytes');
        const client = browser(harness);
        client.socket.write(Buffer.concat([hello, early]));
        const stream = await target.streams.next();
        expect(await readBytes(stream, hello.length + early.length)).toEqual(Buffer.concat([hello, early]));
        client.socket.write('later');
        expect((await readBytes(stream, 5)).toString()).toBe('later');
        expect(stream.client.family).toBe(4);
        expect([...stream.client.address]).toEqual([127, 0, 0, 1]);
        expect(stream.client.port).toBe(client.socket.localPort);
    });

    it('routes an uppercase SNI and an ACME acme-tls/1 ClientHello like any other', async () => {
        const harness = await start();
        const target = await online(harness, 123);
        await pipe(harness, target, target.engine.defaultHostname.toUpperCase());
        const acme = await clientHello(target.engine.defaultHostname, ['acme-tls/1']);
        const client = browser(harness);
        client.socket.write(acme);
        expect(await readBytes(await target.streams.next(), acme.length)).toEqual(acme);
    });

    it('routes a verified custom hostname to its engine', async () => {
        const harness = await start();
        const custom = HostnameSchema.parse('agents.customer.test');
        const engine = await createTestEngine(124, [custom]);
        harness.dns.setAnswer(custom, { kind: 'cname', target: expectedCnameTarget(engine.engineId, ENGINE_DOMAIN) });
        const target = await online(harness, 124, [custom]);
        await pipe(harness, target, custom);
    });

    const tooLarge = Buffer.from([0x16, 0x03, 0x01, 0x40, 0x00, 0x01, 0x00, 0x3f, 0xfc]);

    it.each([
        ['an unknown SNI', () => clientHello('nobody.example.test'), 'unknown-host'],
        ['a ClientHello without SNI', () => clientHello(), 'no-sni'],
        ['plain HTTP', () => Promise.resolve(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n')), 'malformed'],
        ['a ClientHello over 16 KiB', () => Promise.resolve(tooLarge), 'too-large'],
        [
            'an engine hostname with no tunnel here',
            async () => clientHello((await createTestEngine(125)).defaultHostname),
            'engine-offline',
        ],
    ] as const)('closes %s with zero bytes written and logs nothing', async (_, bytes, reason) => {
        const harness = await start();
        const target = await online(harness, 126);
        const hello = await bytes();
        const client = browser(harness);
        client.socket.write(hello);
        expect(await client.closed).toHaveLength(0);
        expect(harness.listener.browser.refusals()[reason]).toBe(1);
        expect(JSON.stringify(harness.logger.entries)).not.toMatch(/nobody|browser|engine\.test"/);
        // The engine never heard of it.
        const opened = await Promise.race([target.streams.next(), Promise.resolve(null)]);
        expect(opened).toBeNull();
    });

    it('treats the too-large fixture as too large', () => {
        expect(parseClientHello(tooLarge, { maxBytes: CLIENT_HELLO_MAX_BYTES })).toEqual({ kind: 'too-large' });
    });

    it('closes a connection whose ClientHello is not complete within the timeout, with zero bytes', async () => {
        const harness = await start();
        const hello = await clientHello(RELAY_ID);
        const client = browser(harness);
        client.socket.write(hello.subarray(0, 20));
        await vi.waitFor(() => {
            expect(harness.listener.browser.bufferedBytes()).toBe(20);
        });
        harness.clock.advance(harness.config.browser.clientHelloTimeoutMs - 1);
        expect(client.socket.readyState).toBe('open');
        expect(harness.listener.browser.refusals().timeout).toBe(0);
        harness.clock.advance(1);
        expect(await client.closed).toHaveLength(0);
        expect(harness.listener.browser.refusals().timeout).toBe(1);
    });

    it('still serves the relay hostname on the same port: /healthz and /v1/tunnel', async () => {
        const harness = await start();
        const status = await new Promise<{ code: number | undefined; body: string }>((resolve, reject) => {
            const req = request(
                {
                    host: '127.0.0.1',
                    port: harness.port,
                    servername: RELAY_ID,
                    ca: harness.certificate.cert,
                    path: '/healthz',
                },
                (response) => {
                    let body = '';
                    response.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
                    response.on('end', () => {
                        resolve({ code: response.statusCode, body });
                    });
                },
            );
            req.on('error', reject);
            req.end();
        });
        expect(status).toEqual({ code: 200, body: 'ok' });
        const target = await online(harness, 127);
        expect(harness.listener.sessions.byEngine(target.engine.engineId)).toBeDefined();
    });

    it('refuses connections over the per-IP limit until one closes', async () => {
        const harness = await start({ RELAY_MAX_CONNECTIONS_PER_IP: '2' });
        const first = browser(harness);
        browser(harness);
        await connectionsReach(harness, 2);
        expect(await browser(harness).closed).toHaveLength(0);
        expect(harness.listener.browser.refusals()['ip-limit']).toBe(1);
        first.socket.destroy();
        await connectionsReach(harness, 1);
        browser(harness);
        await connectionsReach(harness, 2);
    });

    it('refuses connections over the global limit', async () => {
        const harness = await start({ RELAY_MAX_CONNECTIONS: '2' });
        browser(harness);
        browser(harness);
        await connectionsReach(harness, 2);
        expect(await browser(harness).closed).toHaveLength(0);
        expect(harness.listener.browser.refusals()['global-limit']).toBe(1);
    });

    it('refuses new connections from one IP above the rate, until the bucket refills', async () => {
        const harness = await start({ RELAY_NEW_CONNECTIONS_PER_IP_PER_S: '2' });
        browser(harness);
        browser(harness);
        await connectionsReach(harness, 2);
        expect(await browser(harness).closed).toHaveLength(0);
        expect(harness.listener.browser.refusals()['ip-rate']).toBe(1);
        harness.clock.advance(500);
        browser(harness);
        await connectionsReach(harness, 3);
    });

    it('caps open streams per engine and frees the slot when a stream ends', async () => {
        const harness = await start({ RELAY_MAX_STREAMS_PER_ENGINE: '1' });
        const target = await online(harness, 128);
        const first = await pipe(harness, target);
        const refused = browser(harness);
        refused.socket.write(await clientHello(target.engine.defaultHostname));
        expect(await refused.closed).toHaveLength(0);
        expect(harness.listener.browser.refusals()['engine-streams']).toBe(1);
        first.stream.closeWith(CLOSE_CODE.NORMAL);
        await first.browser.closed;
        await pipe(harness, target);
    });

    it('caps new streams per engine per second', async () => {
        const harness = await start({ RELAY_NEW_STREAMS_PER_ENGINE_PER_S: '1' });
        const target = await online(harness, 129);
        await pipe(harness, target);
        const refused = browser(harness);
        refused.socket.write(await clientHello(target.engine.defaultHostname));
        expect(await refused.closed).toHaveLength(0);
        expect(harness.listener.browser.refusals()['engine-rate']).toBe(1);
        harness.clock.advance(1000);
        await pipe(harness, target);
    });

    it('holds an engine to its bandwidth in both directions until the budget refills', async () => {
        const rate = 65_536;
        const harness = await start({ RELAY_ENGINE_BANDWIDTH_BYTES_PER_S: String(rate) });
        const target = await online(harness, 130);
        const { browser: client, stream } = await pipe(harness, target);
        const timers = harness.clock.pendingTimers();

        const upload = randomBytes(256 * 1024);
        const before = stream.received();
        let uploaded = false;
        const uploadDigest = digestOf(stream, upload.length);
        void uploadDigest.then(() => (uploaded = true));
        client.socket.write(upload);
        // The scheduler waits on the clock once the budget is spent.
        await vi.waitFor(() => {
            expect(harness.clock.pendingTimers()).toBe(timers + 1);
        }, PATIENTLY);
        expect(stream.received() - before).toBeLessThanOrEqual(rate + SCHEDULER_SLICE_BYTES);
        await vi.waitFor(() => {
            harness.clock.advance(1000);
            expect(uploaded).toBe(true);
        }, PATIENTLY);
        expect(await uploadDigest).toBe(sha256(upload));

        harness.clock.advance(10_000);
        const download = randomBytes(INITIAL_WINDOW_BYTES * 2);
        const downloaded = digestOf(client.socket, download.length);
        stream.write(download);
        // Credit for what the browser received comes back only as fast as the budget allows.
        await vi.waitFor(() => {
            expect(harness.clock.pendingTimers()).toBe(timers + 1);
        }, PATIENTLY);
        expect(stream.sent()).toBeLessThanOrEqual(INITIAL_WINDOW_BYTES + rate + MAX_FRAME_PAYLOAD_BYTES);
        await vi.waitFor(() => {
            harness.clock.advance(1000);
            expect(stream.sent()).toBe(download.length);
        }, PATIENTLY);
        expect(await downloaded).toBe(sha256(download));
    });

    it(
        'holds at most one window for a browser that stops reading, while another stream keeps flowing',
        async () => {
            const harness = await start(UNTHROTTLED);
            const target = await online(harness, 131);
            const slow = await pipe(harness, target);
            const maxHeld = sampleMax(() => harness.listener.browser.bufferedBytes());
            slow.browser.socket.pause();
            const download = randomBytes(STALL_BYTES);
            slow.stream.write(download);
            // Stalled: the engine spent its credit and the relay holds exactly the bytes it has not returned credit for.
            await vi.waitFor(() => {
                expect(slow.stream.credit()).toBe(0);
                expect(harness.listener.browser.bufferedBytes()).toBe(INITIAL_WINDOW_BYTES);
            }, PATIENTLY);
            expect(maxHeld()).toBeLessThanOrEqual(INITIAL_WINDOW_BYTES);

            const other = await pipe(harness, target);
            other.stream.pipe(other.stream);
            const echo = randomBytes(MIB);
            const echoed = digestOf(other.browser.socket, echo.length);
            other.browser.socket.write(echo);
            expect(await echoed).toBe(sha256(echo));
            expect(slow.stream.sent()).toBeLessThan(STALL_BYTES);
            // Two streams: one stalled window, plus the flowing stream's window and one read chunk.
            expect(maxHeld()).toBeLessThanOrEqual(2 * INITIAL_WINDOW_BYTES + MAX_FRAME_PAYLOAD_BYTES);

            const received = digestOf(slow.browser.socket, download.length);
            slow.browser.socket.resume();
            expect(await received).toBe(sha256(download));
        },
        SLOW_TEST_MS,
    );

    it(
        'stops reading a browser whose engine stops granting credit, while another stream keeps flowing',
        async () => {
            const harness = await start(UNTHROTTLED);
            const target = await online(harness, 132);
            const stuck = await pipe(harness, target);
            const maxHeld = sampleMax(() => harness.listener.browser.bufferedBytes());
            const upload = randomBytes(STALL_BYTES);
            stuck.browser.socket.write(upload);
            // Nobody reads the engine side, so it grants nothing once its buffer is full.
            await vi.waitFor(() => {
                expect(stuck.stream.readableLength).toBeGreaterThanOrEqual(stuck.stream.readableHighWaterMark);
                expect(harness.listener.browser.bufferedBytes()).toBeGreaterThan(0);
            }, PATIENTLY);
            const oneReadAndOneSlice = MAX_FRAME_PAYLOAD_BYTES + SCHEDULER_SLICE_BYTES;
            expect(maxHeld()).toBeLessThanOrEqual(oneReadAndOneSlice);

            const other = await pipe(harness, target);
            other.stream.pipe(other.stream);
            const echo = randomBytes(MIB);
            const echoed = digestOf(other.browser.socket, echo.length);
            other.browser.socket.write(echo);
            expect(await echoed).toBe(sha256(echo));
            expect(stuck.stream.received()).toBeLessThan(STALL_BYTES);
            expect(maxHeld()).toBeLessThanOrEqual(oneReadAndOneSlice + INITIAL_WINDOW_BYTES + MAX_FRAME_PAYLOAD_BYTES);

            expect(await digestOf(stuck.stream, upload.length)).toBe(sha256(upload));
        },
        SLOW_TEST_MS,
    );

    it(
        'stops reading every browser of an engine while its tunnel is backed up',
        async () => {
            const harness = await start({ ...UNTHROTTLED, RELAY_NEW_CONNECTIONS_PER_IP_PER_S: '1000' });
            const target = await online(harness, 133);
            const session = harness.listener.sessions.byEngine(target.engine.engineId);
            if (session === undefined) throw new Error('no session');
            const piped: Piped[] = [];
            for (let index = 0; index < 64; index++) piped.push(await pipe(harness, target));
            const maxQueued = sampleMax(() => session.bufferedBytes());
            target.client.ws.pause();
            const upload = randomBytes(400 * 1024);
            const uploaded = piped.map(({ stream }) => digestOf(stream, upload.length));
            for (const { browser: client } of piped) client.socket.write(upload);
            // Backed up: past the low mark, the scheduler waits for the WebSocket to drain below it.
            await vi.waitFor(() => {
                expect(session.bufferedBytes()).toBeGreaterThan(TUNNEL_LOW_WATER_BYTES);
            }, PATIENTLY);
            const delivered = piped.reduce((total, { stream }) => total + stream.received(), 0);
            expect(delivered).toBeLessThan(piped.length * upload.length);
            // Bounded while backed up. After the resume, a WINDOW may flush the one slice a stream queued beyond its
            // credit straight to the WebSocket: bytes the relay already held, moved, not added.
            const queuedWhileBackedUp = maxQueued();
            stopSampling();
            target.client.ws.resume();
            const digest = sha256(upload);
            for (const result of await Promise.all(uploaded)) expect(result).toBe(digest);
            // One slice may cross the mark, plus frame headers.
            expect(queuedWhileBackedUp).toBeLessThanOrEqual(TUNNEL_HIGH_WATER_BYTES + SCHEDULER_SLICE_BYTES + 4096);
        },
        SLOW_TEST_MS,
    );

    it("delivers a browser's last bytes before CLOSE, even when the engine has to grant credit first", async () => {
        const harness = await start(UNTHROTTLED);
        // An engine that buffers next to nothing grants no credit until it reads.
        const target = await online(harness, 137, [], { readableHighWaterMark: 1 });
        const { browser: client, stream } = await pipe(harness, target);
        const credited = stream.received();
        const upload = randomBytes(INITIAL_WINDOW_BYTES + 100);
        client.socket.end(upload);
        // The relay spent the window, read the browser's FIN and closed its own side (no half-open streams).
        await once(client.socket, 'end');
        expect(stream.received() - credited).toBe(INITIAL_WINDOW_BYTES);
        // Nothing can reach the browser any more: the relay drops this.
        stream.write('too late');
        expect(await digestOf(stream, upload.length)).toBe(sha256(upload));
        expect(await stream.remoteClose).toBe(CLOSE_CODE.NORMAL);
        expect((await client.closed).toString()).toBe('');
    });

    it(
        "delivers what it holds for a stalled browser after the engine's CLOSE NORMAL, then ends",
        async () => {
            const harness = await start(UNTHROTTLED);
            const target = await online(harness, 138);
            const { browser: client, stream } = await pipe(harness, target);
            client.socket.pause();
            stream.write(randomBytes(STALL_BYTES));
            await vi.waitFor(() => {
                expect(stream.credit()).toBe(0);
                expect(harness.listener.browser.bufferedBytes()).toBe(INITIAL_WINDOW_BYTES);
            }, PATIENTLY);
            stream.closeWith(CLOSE_CODE.NORMAL);
            expect(harness.listener.browser.bufferedBytes()).toBe(INITIAL_WINDOW_BYTES);
            client.socket.resume();
            expect((await client.closed).length).toBe(stream.sent());
        },
        SLOW_TEST_MS,
    );

    it('destroys the browser sockets of a tunnel that dies', async () => {
        const harness = await start();
        const target = await online(harness, 134);
        const { browser: client } = await pipe(harness, target);
        target.client.ws.terminate();
        await client.closed;
        expect(client.socket.destroyed).toBe(true);
    });

    it('sends CLOSE NORMAL when the browser closes and RESET when it resets', async () => {
        const harness = await start();
        const target = await online(harness, 135);
        const polite = await pipe(harness, target);
        polite.browser.socket.write('last words');
        polite.browser.socket.end();
        expect((await readBytes(polite.stream, 10)).toString()).toBe('last words');
        expect(await polite.stream.remoteClose).toBe(CLOSE_CODE.NORMAL);
        const rude = await pipe(harness, target);
        rude.browser.socket.resetAndDestroy();
        expect(await rude.stream.remoteClose).toBe(CLOSE_CODE.RESET);
    });

    it("ends the browser socket after the engine's last bytes on CLOSE NORMAL, and resets it otherwise", async () => {
        const harness = await start();
        const target = await online(harness, 136);
        const polite = await pipe(harness, target);
        polite.stream.write('goodbye');
        polite.stream.closeWith(CLOSE_CODE.NORMAL);
        expect((await polite.browser.closed).toString()).toBe('goodbye');
        const rude = await pipe(harness, target);
        rude.stream.closeWith(CLOSE_CODE.RESET);
        expect(await rude.browser.closed).toHaveLength(0);
    });

    it('destroys connections still sending their ClientHello on close', async () => {
        const harness = await start();
        const client = browser(harness);
        await connectionsReach(harness, 1);
        await harness.close();
        relay = undefined;
        expect(await client.closed).toHaveLength(0);
    });
});
