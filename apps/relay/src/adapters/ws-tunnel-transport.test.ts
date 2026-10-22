import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawData } from 'ws';
import { WebSocket, WebSocketServer } from 'ws';

import { TUNNEL_CLOSE_CODE } from '@ptbk/protocol';

import type { MemoryBudget } from '../domain/limits/memory-budget';
import { createMemoryBudget } from '../domain/limits/memory-budget';
import type { TunnelTerminationReason } from '../domain/metrics/reason-counters';
import type { ConnectionEvents, PendingConnection, TunnelConnection } from '../domain/tunnel/tunnel-endpoint';
import { testWsTunnelOptions } from '../testing/tunnel-options';
import type { FakeClock } from './fake-clock';
import { createFakeClock } from './fake-clock';
import type { MemoryLogger } from './memory-logger';
import { createMemoryLogger } from './memory-logger';
import type { WsTunnelLimits } from './ws-tunnel-transport';
import { PING_PAYLOAD_BYTES, PONG_TIMEOUT_MS, attachWsTunnel } from './ws-tunnel-transport';

interface Recorded {
    readonly texts: string[];
    readonly binary: Uint8Array[];
    readonly closes: number[];
}

const SMALL_LIMITS: WsTunnelLimits = { pingBufferBytes: 16_384, maxBufferedBytes: 1_048_576 };

describe('attachWsTunnel', () => {
    let server: WebSocketServer;
    let clock: FakeClock;
    let recorded: Recorded;
    let attached: Promise<TunnelConnection>;
    let client: WebSocket;
    let logger: MemoryLogger;
    let memory: MemoryBudget;
    let terminated: TunnelTerminationReason[];
    /** Thrown by the endpoint's `binary` handler, to stand for a bug. */
    let failure: unknown;

    beforeEach(async () => {
        clock = createFakeClock();
        logger = createMemoryLogger();
        memory = createMemoryBudget(1_073_741_824);
        terminated = [];
        failure = undefined;
        // Per test: a previous test's connection may still report its close after this one starts.
        const local: Recorded = { texts: [], binary: [], closes: [] };
        recorded = local;
        // As the relay runs it: pings are answered by `attachWsTunnel`, not by `ws`.
        server = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: false });
        await new Promise((resolve) => server.once('listening', resolve));
        attached = new Promise((resolve) => {
            server.once('connection', (ws) => {
                const pending: PendingConnection = {
                    attach(connection): ConnectionEvents {
                        resolve(connection);
                        return {
                            text: (text) => {
                                local.texts.push(text);
                            },
                            binary: (message) => {
                                // eslint-disable-next-line @typescript-eslint/only-throw-error -- non-Error throws are a case
                                if (failure !== undefined) throw failure;
                                local.binary.push(message);
                            },
                            closed: (code) => {
                                local.closes.push(code);
                            },
                        };
                    },
                    socketClosed: () => undefined,
                };
                attachWsTunnel(
                    ws,
                    pending,
                    testWsTunnelOptions(clock, {
                        logger,
                        memory,
                        limits: SMALL_LIMITS,
                        terminations: { count: (reason) => terminated.push(reason) },
                    }),
                );
            });
        });
        client = new WebSocket(`ws://127.0.0.1:${String((server.address() as AddressInfo).port)}`, { autoPong: false });
        client.on('error', () => undefined);
        await new Promise((resolve) => client.once('open', resolve));
    });
    afterEach(async () => {
        client.terminate();
        await new Promise((resolve) => {
            server.close(resolve);
        });
    });

    const received = (): Promise<{ data: RawData; isBinary: boolean }> =>
        new Promise((resolve) =>
            client.once('message', (data: RawData, isBinary: boolean) => {
                resolve({ data, isBinary });
            }),
        );

    it('passes text and binary messages through and sends both kinds', async () => {
        const connection = await attached;
        client.send('{"type":"auth"}');
        client.send(Uint8Array.of(1, 2, 3));
        await vi.waitFor(() => {
            expect(recorded.binary).toHaveLength(1);
        });
        expect(recorded.texts).toEqual(['{"type":"auth"}']);
        expect([...(recorded.binary[0] ?? [])]).toEqual([1, 2, 3]);
        const text = received();
        connection.sendText('hello');
        expect(await text).toMatchObject({ isBinary: false });
        const frame = received();
        expect(connection.transport.send(Uint8Array.of(9))).toBe(true);
        expect(await frame).toMatchObject({ isBinary: true });
        expect(connection.transport.bufferedBytes()).toBeGreaterThanOrEqual(0);
    });

    it('wakes a drain waiter once a written frame leaves less than its mark queued', async () => {
        const connection = await attached;
        const woken: string[] = [];
        connection.transport.whenBufferedBelow(1, () => woken.push('drained'));
        connection.transport.whenBufferedBelow(0, () => woken.push('never: nothing is below 0'));
        const cancel = connection.transport.whenBufferedBelow(1, () => woken.push('cancelled'));
        cancel();
        const frame = received();
        connection.transport.send(new Uint8Array(1000));
        await frame;
        await vi.waitFor(() => {
            expect(woken).toEqual(['drained']);
        });
        connection.transport.whenBufferedBelow(1, () => woken.push('after close'));
        const clientClosed = new Promise((resolve) => client.once('close', resolve));
        connection.transport.send(new Uint8Array(1000));
        connection.transport.close(4003, '');
        await clientClosed;
        expect(woken).toEqual(['drained']);
    });

    it('reports the close code once and ignores sends after closing', async () => {
        const connection = await attached;
        const clientClosed = new Promise<number>((resolve) => client.once('close', resolve));
        connection.transport.close(4003, '');
        connection.transport.close(4001, '');
        expect(connection.transport.send(Uint8Array.of(1))).toBe(false);
        connection.sendText('late');
        // A ping due while the close handshake runs is skipped.
        clock.advance(25_000);
        expect(await clientClosed).toBe(4003);
        await vi.waitFor(() => {
            expect(recorded.closes).toEqual([4003]);
        });
        expect(clock.pendingTimers()).toBe(0);
    });

    const nextPing = (): Promise<Buffer> => new Promise((resolve) => client.once('ping', resolve));
    /** Sends a ping and waits for the relay's answer: by then it has handled everything sent before it. */
    const roundTrip = async (payload = Buffer.from('probe')): Promise<Buffer> => {
        const answered = new Promise<Buffer>((resolve) => client.once('pong', resolve));
        client.ping(payload);
        return answered;
    };

    it('pings every interval with a random payload and terminates when a pong is late', async () => {
        await attached;
        const pinged = nextPing();
        clock.advance(25_000);
        expect((await pinged).length).toBe(PING_PAYLOAD_BYTES);
        clock.advance(PONG_TIMEOUT_MS);
        await vi.waitFor(() => {
            expect(recorded.closes).toEqual([1006]);
        });
        expect(terminated).toEqual(['pong-timeout']);
        expect(logger.entries).toEqual([
            { level: 'warn', event: 'tunnel.terminated', fields: { reason: 'pong-timeout' } },
        ]);
    });

    it('keeps a connection whose pongs echo the ping', async () => {
        await attached;
        const pinged = nextPing();
        clock.advance(25_000);
        client.pong(await pinged);
        await roundTrip();
        clock.advance(PONG_TIMEOUT_MS);
        expect(recorded.closes).toEqual([]);
        expect(clock.pendingTimers()).toBe(1);
        // The next ping carries a new payload.
        const again = nextPing();
        clock.advance(25_000 - PONG_TIMEOUT_MS);
        expect((await again).equals(await pinged)).toBe(false);
    });

    it('does not count an unsolicited or non-echoing pong as alive', async () => {
        await attached;
        client.pong(Buffer.from('unsolicited'));
        const pinged = nextPing();
        clock.advance(25_000);
        const payload = await pinged;
        client.pong(Buffer.from('not the payload'));
        client.pong(Buffer.alloc(PING_PAYLOAD_BYTES));
        client.pong();
        await roundTrip();
        clock.advance(PONG_TIMEOUT_MS);
        await vi.waitFor(() => {
            expect(recorded.closes).toEqual([1006]);
        });
        expect(payload.length).toBe(PING_PAYLOAD_BYTES);
    });

    it('answers pings itself, echoing the payload', async () => {
        await attached;
        expect((await roundTrip(Buffer.from('hello'))).toString()).toBe('hello');
    });

    it('terminates a peer that floods pings without reading the pongs', async () => {
        await attached;
        client.pause();
        const payload = Buffer.alloc(125, 1);
        for (let batch = 0; batch < 200 && recorded.closes.length === 0; batch++) {
            for (let index = 0; index < 1000; index++) client.ping(payload);
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        await vi.waitFor(() => {
            expect(recorded.closes).toEqual([1006]);
        });
        expect(terminated).toEqual(['ping-buffer']);
        expect(memory.used()).toBe(0);
    });

    it('terminates a tunnel whose send queue would pass its cap, and settles its memory', async () => {
        const connection = await attached;
        client.pause();
        let sent = 0;
        while (connection.transport.send(new Uint8Array(65_536))) {
            sent++;
            if (sent % 64 === 0) await new Promise((resolve) => setTimeout(resolve, 1));
        }
        expect(memory.used()).toBeGreaterThan(SMALL_LIMITS.maxBufferedBytes - 65_536);
        await vi.waitFor(() => {
            expect(recorded.closes).toEqual([1006]);
        });
        expect(terminated).toEqual(['send-buffer']);
        expect(memory.used()).toBe(0);
        expect(connection.transport.send(Uint8Array.of(1))).toBe(false);
    });

    it('counts queued frames against the memory budget until they are written', async () => {
        const connection = await attached;
        const frame = received();
        connection.transport.send(new Uint8Array(1000));
        expect(memory.used()).toBe(1000);
        await frame;
        await vi.waitFor(() => {
            expect(memory.used()).toBe(0);
        });
    });

    it.each([
        ['an Error', new RangeError('detail that may quote input'), 'RangeError'],
        ['anything else', 'detail', 'unknown'],
    ])(
        'closes the tunnel with PROTOCOL_ERROR when a handler throws %s, logging only its name',
        async (_, thrown, name) => {
            await attached;
            failure = thrown;
            const clientClosed = new Promise<number>((resolve) => client.once('close', resolve));
            client.send(Uint8Array.of(1));
            expect(await clientClosed).toBe(TUNNEL_CLOSE_CODE.PROTOCOL_ERROR);
            expect(logger.entries).toEqual([{ level: 'error', event: 'tunnel.failed', fields: { problem: name } }]);
            expect(terminated).toEqual(['failed']);
        },
    );
});
