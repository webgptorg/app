import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawData } from 'ws';
import { WebSocket, WebSocketServer } from 'ws';

import type { ConnectionEvents, PendingConnection, TunnelConnection } from '../domain/tunnel/tunnel-endpoint';
import type { FakeClock } from './fake-clock';
import { createFakeClock } from './fake-clock';
import { PONG_TIMEOUT_MS, attachWsTunnel } from './ws-tunnel-transport';

interface Recorded {
    readonly texts: string[];
    readonly binary: Uint8Array[];
    readonly closes: number[];
}

describe('attachWsTunnel', () => {
    let server: WebSocketServer;
    let clock: FakeClock;
    let recorded: Recorded;
    let attached: Promise<TunnelConnection>;
    let client: WebSocket;

    beforeEach(async () => {
        clock = createFakeClock();
        // Per test: a previous test's connection may still report its close after this one starts.
        const local: Recorded = { texts: [], binary: [], closes: [] };
        recorded = local;
        server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
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
                                local.binary.push(message);
                            },
                            closed: (code) => {
                                local.closes.push(code);
                            },
                        };
                    },
                    socketClosed: () => undefined,
                };
                attachWsTunnel(ws, pending, { clock });
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

    it('pings every interval and terminates when a pong is late', async () => {
        await attached;
        const pinged = new Promise((resolve) => client.once('ping', resolve));
        clock.advance(25_000);
        await pinged;
        clock.advance(PONG_TIMEOUT_MS);
        await vi.waitFor(() => {
            expect(recorded.closes).toEqual([1006]);
        });
    });

    it('keeps a connection whose pongs arrive', async () => {
        await attached;
        const pinged = new Promise((resolve) => client.once('ping', resolve));
        clock.advance(25_000);
        await pinged;
        client.pong();
        const echoed = new Promise((resolve) => client.once('pong', resolve));
        client.ping();
        await echoed;
        clock.advance(PONG_TIMEOUT_MS);
        expect(recorded.closes).toEqual([]);
        expect(clock.pendingTimers()).toBe(1);
    });
});
