import type { AddressInfo, Socket } from 'node:net';
import { connect, createServer } from 'node:net';

import type { CloseCode } from '@ptbk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMemoryBudget } from '../domain/limits/memory-budget';
import { createStreamScheduler } from '../domain/routing/stream-scheduler';
import type { StreamHandlers, TunnelStream } from '../domain/tunnel/tunnel-session';
import { createFakeClock } from './fake-clock';
import { STREAM_RESERVE_BYTES, pipeSocketToStream } from './socket-stream-pipe';

const LIMITS = { firstByteTimeoutMs: 10_000, drainTimeoutMs: 30_000, endTimeoutMs: 30_000 };

/** A connected pair: the relay's side, paused with no reader yet, and the browser's. */
async function socketPair(): Promise<{ readonly relay: Socket; readonly browser: Socket; close(): Promise<void> }> {
    const server = createServer({ pauseOnConnect: true });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const accepted = new Promise<Socket>((resolve) => server.once('connection', resolve));
    const browser = connect((server.address() as AddressInfo).port, '127.0.0.1');
    const relay = await accepted;
    return {
        relay,
        browser,
        async close() {
            browser.destroy();
            relay.destroy();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

describe('pipeSocketToStream', () => {
    let close: () => Promise<void> = () => Promise.resolve();

    afterEach(async () => {
        await close();
    });

    it('reserves a window and one read per stream, and stops reading the browser while the budget is over', async () => {
        const pair = await socketPair();
        close = () => pair.close();
        const clock = createFakeClock();
        const memory = createMemoryBudget(10 * STREAM_RESERVE_BYTES);
        const written: Uint8Array[] = [];
        const closes: CloseCode[] = [];
        let handlers: StreamHandlers | null = null;
        const stream: TunnelStream = {
            id: 1 as TunnelStream['id'],
            write(bytes) {
                written.push(bytes);
                return true;
            },
            consumed: () => undefined,
            close: (code) => closes.push(code),
            queuedBytes: () => 0,
        };
        const pipe = pipeSocketToStream({
            socket: pair.relay,
            first: Uint8Array.of(1),
            open: (given) => {
                handlers = given;
                return stream;
            },
            scheduler: createStreamScheduler({
                tunnel: { bufferedBytes: () => 0, whenBufferedBelow: () => () => undefined },
                throttle: () => 0,
                clock,
            }),
            throttle: () => 0,
            countTraffic: () => undefined,
            clock,
            limits: LIMITS,
            memory,
            countReset: () => undefined,
            onStreamEnd: () => undefined,
            onDone: () => undefined,
            onFailure: () => undefined,
        });
        expect(pipe).not.toBeNull();
        expect(handlers).not.toBeNull();
        expect(memory.used()).toBe(STREAM_RESERVE_BYTES);
        const received = (): number => written.reduce((total, bytes) => total + bytes.length, 0);

        // Something else holds the budget over: the next read goes through, then the pipe waits.
        memory.adjust(10 * STREAM_RESERVE_BYTES);
        pair.browser.write('first');
        await vi.waitFor(() => {
            expect(received()).toBe(1 + 5);
        });
        pair.browser.write('second');
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(received()).toBe(6);
        memory.adjust(-10 * STREAM_RESERVE_BYTES);
        await vi.waitFor(() => {
            expect(received()).toBe(6 + 6);
        });
        expect(closes).toEqual([]);
    });
});
