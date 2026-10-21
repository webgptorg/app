import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';
import type { RawData, WebSocket } from 'ws';

import type { EngineHarness } from '../../testing/engine-harness';
import { HARNESS_CANARY, HARNESS_ENGINE_ID, createEngineHarness } from '../../testing/engine-harness';
import type { FakeClock } from '../../testing/fake-clock';
import { createFakeClock } from '../../testing/fake-clock';
import { DOWNLOAD_CHUNK_BYTES, SCREENCAST_HEADER_BYTES, SPIKE_LIMITS } from './spike-routes';

const MIB = 1024 * 1024;

let harness: EngineHarness | undefined;
afterEach(() => {
    harness?.close();
    harness = undefined;
});

function start(options: Parameters<typeof createEngineHarness>[0] = {}): EngineHarness {
    harness = createEngineHarness(options);
    return harness;
}

/** A fake clock at the real time, so the dev CA's certificates are valid for the TLS client. */
function fakeClock(): FakeClock {
    return createFakeClock(Date.now());
}

async function turns(count: number): Promise<void> {
    for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Lets the event loop run until `done()` holds; fails instead of hanging if it never does. */
async function until(done: () => boolean, maxTurns = 2_000): Promise<void> {
    for (let i = 0; i < maxTurns && !done(); i++) await turns(1);
    if (!done()) throw new Error('condition not reached');
}

function sha256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

interface SseReader {
    ids(): readonly number[];
    readonly ended: Promise<void>;
}

function readSse(response: IncomingMessage): SseReader {
    let text = '';
    const ids: number[] = [];
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
        text += chunk;
        let end = text.indexOf('\n\n');
        while (end !== -1) {
            const event = text.slice(0, end);
            text = text.slice(end + 2);
            const id = /^id: (\d+)$/m.exec(event)?.[1];
            const data = /^data: (.*)$/m.exec(event)?.[1];
            expect(JSON.parse(data ?? 'null')).toEqual({ id: Number(id) });
            ids.push(Number(id));
            end = text.indexOf('\n\n');
        }
    });
    const ended = new Promise<void>((resolve) => response.once('end', resolve));
    return { ids: () => ids, ended };
}

function nextMessage(socket: WebSocket): Promise<{ readonly data: Buffer; readonly isBinary: boolean }> {
    return new Promise((resolve) => {
        socket.once('message', (data: RawData, isBinary) => {
            resolve({ data: data as Buffer, isBinary });
        });
    });
}

describe('GET /__spike/sse', () => {
    it('sends N events with increasing IDs at the requested interval', async () => {
        const clock = fakeClock();
        const engine = start({ clock });
        const response = await engine.stream('/__spike/sse?count=5&intervalMs=1000');
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe('text/event-stream; charset=utf-8');
        const sse = readSse(response);
        await until(() => sse.ids().length === 1);
        for (let received = 2; received <= 5; received++) {
            clock.advance(999);
            await turns(10);
            expect(sse.ids()).toHaveLength(received - 1);
            clock.advance(1);
            await until(() => sse.ids().length === received);
        }
        await sse.ended;
        expect(sse.ids()).toEqual([1, 2, 3, 4, 5]);
    });

    it('resumes after Last-Event-ID', async () => {
        const clock = fakeClock();
        const engine = start({ clock });
        const response = await engine.stream('/__spike/sse?count=5&intervalMs=10', {
            headers: { 'Last-Event-ID': '3' },
        });
        const sse = readSse(response);
        await until(() => sse.ids().length === 1);
        clock.advance(10);
        await sse.ended;
        expect(sse.ids()).toEqual([4, 5]);
    });

    it('answers 204 once every event was delivered, so an EventSource stops reconnecting', async () => {
        const engine = start();
        for (const lastEventId of ['5', '6', '1000']) {
            const response = await engine.get('/__spike/sse?count=5', { headers: { 'Last-Event-ID': lastEventId } });
            expect(response.status).toBe(204);
            expect(response.body).toHaveLength(0);
        }
    });

    it('defaults to 20 events a second apart', async () => {
        const clock = fakeClock();
        const engine = start({ clock });
        const sse = readSse(await engine.stream('/__spike/sse'));
        await until(() => sse.ids().length === 1);
        for (let received = 2; received <= 20; received++) {
            clock.advance(1000);
            await until(() => sse.ids().length === received);
        }
        await sse.ended;
    });

    it('refuses a malformed or out-of-range Last-Event-ID', async () => {
        const engine = start();
        for (const lastEventId of ['abc', '-1', '01', '1e3', String(SPIKE_LIMITS.sseMaxCount + 1)]) {
            const response = await engine.get('/__spike/sse?count=5', { headers: { 'Last-Event-ID': lastEventId } });
            expect(response.status, lastEventId).toBe(400);
            expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({ code: 'validation-failed' });
        }
    });

    it('cancels its timer when the client goes away', async () => {
        const clock = fakeClock();
        const engine = start({ clock });
        // The dev CA source keeps one renewal timer.
        const baseline = clock.pendingTimers();
        const response = await engine.stream('/__spike/sse?count=100&intervalMs=1000');
        const sse = readSse(response);
        await until(() => sse.ids().length === 1);
        expect(clock.pendingTimers()).toBe(baseline + 1);
        response.destroy();
        await until(() => clock.pendingTimers() === baseline);
        clock.advance(10_000);
        await turns(10);
        expect(sse.ids()).toEqual([1]);
    });
});

describe('WS /__spike/ws', () => {
    it('echoes text as text and binary as binary', async () => {
        const socket = await start().webSocket('/__spike/ws');
        const text = nextMessage(socket);
        socket.send('hello through the tunnel');
        expect(await text).toEqual({ data: Buffer.from('hello through the tunnel'), isBinary: false });
        const binary = nextMessage(socket);
        socket.send(Buffer.of(0, 1, 2, 255));
        expect(await binary).toEqual({ data: Buffer.of(0, 1, 2, 255), isBinary: true });
        socket.close();
    });

    it('echoes a 1 MiB binary message intact', async () => {
        const socket = await start().webSocket('/__spike/ws');
        const payload = randomBytes(SPIKE_LIMITS.echoMaxMessageBytes);
        const echoed = nextMessage(socket);
        socket.send(payload);
        const { data, isBinary } = await echoed;
        expect(isBinary).toBe(true);
        expect(data).toHaveLength(MIB);
        expect(sha256(data)).toBe(sha256(payload));
        socket.close();
    });

    it('closes with 1009 on a message over 1 MiB', async () => {
        const socket = await start().webSocket('/__spike/ws');
        const closed = new Promise<number>((resolve) => socket.once('close', resolve));
        socket.send(Buffer.alloc(MIB + 1));
        expect(await closed).toBe(1009);
    });

    it('keeps echoing, in order, when the client sends faster than it reads', async () => {
        const socket = await start().webSocket('/__spike/ws');
        const received: Buffer[] = [];
        socket.on('message', (data: RawData) => received.push(data as Buffer));
        // 24 MiB in flight is far past the echo's 4 MiB high-water mark, so it pauses and resumes reading.
        const messages = Array.from({ length: 24 }, (_, index) => Buffer.alloc(MIB, index));
        for (const message of messages) socket.send(message);
        await until(() => received.length === messages.length, 100_000);
        expect(received.map((message) => message[0])).toEqual(messages.map((_, index) => index));
        socket.close();
    });
});

describe('WS /__spike/screencast', () => {
    interface Frame {
        readonly sequence: number;
        readonly sentAtMs: number;
        readonly length: number;
    }

    /** Frame 0 can arrive in the same read as the upgrade response, so listen before the socket opens. */
    async function openScreencast(engine: EngineHarness, path: string) {
        const frames: Frame[] = [];
        const socket = await engine.webSocket(path, {
            onSocket: (created) => {
                created.on('message', (data: RawData, isBinary) => {
                    expect(isBinary).toBe(true);
                    const frame = data as Buffer;
                    frames.push({
                        sequence: frame.readUInt32BE(0),
                        sentAtMs: frame.readDoubleBE(4),
                        length: frame.length,
                    });
                });
            },
        });
        return { socket, frames };
    }

    it('sends the requested fps over 5 s, each frame stamped with its sequence and send time', async () => {
        const clock = fakeClock();
        const engine = start({ clock });
        const baseline = clock.pendingTimers();
        const { socket, frames } = await openScreencast(engine, '/__spike/screencast?fps=10&bytes=4096');
        await until(() => frames.length === 1);
        const startMs = frames[0]?.sentAtMs ?? Number.NaN;
        for (let step = 1; step <= 50; step++) {
            clock.advance(100);
            await until(() => frames.length === step + 1);
        }
        const inFiveSeconds = frames.filter((frame) => frame.sentAtMs - startMs < 5_000);
        expect(inFiveSeconds.length).toBeGreaterThanOrEqual(45);
        expect(inFiveSeconds.length).toBeLessThanOrEqual(55);
        frames.forEach((frame, index) => {
            expect(frame).toEqual({ sequence: index, sentAtMs: startMs + index * 100, length: 4096 });
        });

        socket.close();
        await until(() => clock.pendingTimers() === baseline);
        clock.advance(1_000);
        await turns(10);
        expect(frames).toHaveLength(51);
    });

    it('drops frames rather than queue them behind a slow reader', async () => {
        const clock = fakeClock();
        const engine = start({ clock });
        const { socket, frames } = await openScreencast(
            engine,
            `/__spike/screencast?fps=${String(SPIKE_LIMITS.screencastMaxFps)}&bytes=${String(MIB)}`,
        );
        await until(() => frames.length === 1);
        // Ten ticks with no turn of the event loop in between: nothing drains, so the queue cap is reached.
        for (let tick = 0; tick < 10; tick++) clock.advance(34);
        await until(() => frames.length >= 2);
        await turns(500);
        const sent = frames.length;
        expect(sent).toBeLessThan(11);
        expect(frames.map((frame) => frame.sequence)).toEqual(Array.from({ length: sent }, (_, index) => index));
        // Once the queue drained, the next tick sends again, and its sequence number shows the frames skipped.
        clock.advance(34);
        await until(() => frames.length === sent + 1);
        expect(frames[sent]?.sequence).toBe(11);
        expect(frames.every((frame) => frame.length === MIB)).toBe(true);
        socket.close();
    });

    it('defaults to 5 fps and 64 KiB frames', async () => {
        const clock = fakeClock();
        const { socket, frames } = await openScreencast(start({ clock }), '/__spike/screencast');
        await until(() => frames.length === 1);
        clock.advance(199);
        await turns(10);
        expect(frames).toHaveLength(1);
        clock.advance(1);
        await until(() => frames.length === 2);
        expect(frames[1]?.length).toBe(64 * 1024);
        socket.close();
    });

    it('accepts the smallest frame, header only', async () => {
        const { socket, frames } = await openScreencast(
            start({ clock: fakeClock() }),
            `/__spike/screencast?fps=1&bytes=${String(SCREENCAST_HEADER_BYTES)}`,
        );
        await until(() => frames.length === 1);
        expect(frames[0]?.length).toBe(SCREENCAST_HEADER_BYTES);
        socket.close();
    });
});

describe('GET /__spike/download', () => {
    it('streams exactly the requested bytes with Content-Length', async () => {
        const engine = start();
        const response = await engine.get(`/__spike/download?bytes=${String(5 * MIB)}`);
        expect(response.status).toBe(200);
        expect(response.headers['content-length']).toBe(String(5 * MIB));
        expect(response.headers['content-type']).toBe('application/octet-stream');
        expect(response.body).toHaveLength(5 * MIB);
        expect([...response.body.subarray(0, 3)]).toEqual([0, 1, 2]);
    });

    it('streams an empty body for 0 bytes', async () => {
        const response = await start().get('/__spike/download?bytes=0');
        expect(response.status).toBe(200);
        expect(response.headers['content-length']).toBe('0');
        expect(response.body).toHaveLength(0);
    });

    it('produces only as fast as a paused reader drains, then finishes when it resumes', async () => {
        let produced = 0;
        const engine = start({ onDownloadBytes: (bytes) => (produced += bytes) });
        const total = 32 * MIB;
        const response = await engine.stream(`/__spike/download?bytes=${String(total)}`);
        let received = 0;
        await new Promise<void>((resolve) => {
            response.once('data', (chunk: Buffer) => {
                received += chunk.length;
                response.pause();
                resolve();
            });
        });
        await turns(500);
        const whilePaused = produced;
        await turns(500);
        // Nothing moves while the reader is paused: socket, TLS and duplex buffers filled once and stayed full.
        expect(produced).toBe(whilePaused);
        expect(whilePaused).toBeLessThan(total);

        response.on('data', (chunk: Buffer) => (received += chunk.length));
        const ended = new Promise((resolve) => response.once('end', resolve));
        response.resume();
        await ended;
        expect(received).toBe(total);
        expect(produced).toBe(total);
    });

    it('keeps memory bounded at the 1 GiB cap with a paused reader', async () => {
        let produced = 0;
        const engine = start({ onDownloadBytes: (bytes) => (produced += bytes) });
        const response = await engine.stream(`/__spike/download?bytes=${String(SPIKE_LIMITS.downloadMaxBytes)}`);
        expect(response.headers['content-length']).toBe(String(SPIKE_LIMITS.downloadMaxBytes));
        await new Promise<void>((resolve) => {
            response.once('data', () => {
                response.pause();
                resolve();
            });
        });
        await turns(1_000);
        /*
         * What is in flight is a few stream high-water marks (HTTP response, TLS socket, the duplex pair standing in
         * for the tunnel) and a chunk per stage: measured at 256 KiB. The bound leaves room for buffer sizes to change
         * between Node versions; without backpressure the generator would run far past it in these turns.
         */
        expect(produced).toBeLessThan(4 * MIB);
        expect(produced % DOWNLOAD_CHUNK_BYTES).toBe(0);
        response.destroy();
    });
});

describe('the spike page', () => {
    it('serves a static page at /__spike/ naming the engine (the app has /)', async () => {
        const engine = start();
        const spike = await engine.get('/__spike/');
        expect(spike.status).toBe(200);
        expect(spike.headers['content-type']).toBe('text/html; charset=utf-8');
        const html = spike.body.toString('utf8');
        expect(html).toContain(`<code id="engine-id">${HARNESS_ENGINE_ID}</code>`);
        expect(html).toContain(`<code id="canary">${HARNESS_CANARY}</code>`);
        expect(html).not.toMatch(/<script|<style|\sstyle=|\son[a-z]+=/i);
    });
});

describe('query limits', () => {
    const invalid: readonly string[] = [
        '/__spike/?x=1',
        '/__spike/whoami?x=1',
        '/__spike/sse?x=1',
        '/__spike/sse?count=1&count=2',
        '/__spike/sse?count=abc',
        '/__spike/sse?count=-1',
        '/__spike/sse?count=01',
        '/__spike/sse?count=1e3',
        '/__spike/sse?count=0',
        '/__spike/sse?count=',
        `/__spike/sse?count=${String(SPIKE_LIMITS.sseMaxCount + 1)}`,
        `/__spike/sse?intervalMs=${String(SPIKE_LIMITS.sseMaxIntervalMs + 1)}`,
        '/__spike/download',
        '/__spike/download?bytes=1.5',
        '/__spike/download?bytes=99999999999',
        `/__spike/download?bytes=${String(SPIKE_LIMITS.downloadMaxBytes + 1)}`,
        '/__spike/download?bytes=10&bytes=10',
    ];

    it.each(invalid)('GET %s is a 400 problem', async (path) => {
        const response = await start().get(path);
        expect(response.status).toBe(400);
        expect(response.headers['content-type']).toBe('application/problem+json');
        expect(JSON.parse(response.body.toString('utf8'))).toMatchObject({ status: 400, code: 'validation-failed' });
    });

    const invalidUpgrades: readonly string[] = [
        '/__spike/ws?x=1',
        '/__spike/screencast?x=1',
        '/__spike/screencast?fps=0',
        `/__spike/screencast?fps=${String(SPIKE_LIMITS.screencastMaxFps + 1)}`,
        `/__spike/screencast?bytes=${String(SCREENCAST_HEADER_BYTES - 1)}`,
        `/__spike/screencast?bytes=${String(SPIKE_LIMITS.screencastMaxFrameBytes + 1)}`,
        '/__spike/screencast?fps=5&fps=5',
    ];

    it.each(invalidUpgrades)('WS %s is refused with 400', async (path) => {
        await expect(start().webSocket(path)).rejects.toThrow('unexpected response 400');
    });
});
