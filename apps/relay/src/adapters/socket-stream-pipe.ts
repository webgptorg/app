import type { Socket } from 'node:net';

import type { CloseCode } from '@ptbk/protocol';
import { CLOSE_CODE } from '@ptbk/protocol';

import type { Clock } from '../domain/clock';
import type { TrafficDirection } from '../domain/metrics/traffic-counters';
import type { StreamScheduler } from '../domain/routing/stream-scheduler';
import type { StreamHandlers, TunnelStream } from '../domain/tunnel/tunnel-session';

export interface SocketStreamPipeOptions {
    /** Paused, with no `data` listener, so nothing is read before the pipe takes over. */
    readonly socket: Socket;
    /** Everything read while the ClientHello was judged, including bytes after it: the stream's first DATA. */
    readonly first: Uint8Array;
    /** Opens the tunnel stream (`TunnelSession.openStream`); `null` if the tunnel is gone. */
    readonly open: (handlers: StreamHandlers) => TunnelStream | null;
    /** The scheduler of the stream's tunnel. */
    readonly scheduler: StreamScheduler;
    /** Charges the engine's bandwidth budget for engine-to-browser bytes; milliseconds to hold back credit. */
    readonly throttle: (bytes: number) => number;
    readonly countTraffic: (direction: TrafficDirection, bytes: number) => void;
    readonly clock: Clock;
    /** Called once, when the stream ends from either side. */
    readonly onStreamEnd: () => void;
}

export interface SocketStreamPipe {
    /** Bytes held for this connection: queued for the engine, or written to the browser and not yet flushed. */
    readonly bufferedBytes: () => number;
}

/**
 * Pipes a browser socket into a tunnel stream without looking at the bytes. Browser to engine: the socket is read one
 * chunk at a time and only while the stream has credit. Engine to browser: credit goes back to the engine only once
 * the socket has flushed the bytes, so a browser that stops reading holds at most one window here. Either side
 * closing ends the other; a reset ends both at once.
 */
export function pipeSocketToStream(options: SocketStreamPipeOptions): SocketStreamPipe | null {
    const { socket, first, scheduler, throttle, countTraffic, clock, onStreamEnd } = options;
    let ended = false;
    let browserEnded = false;
    let inFlight = false;
    let withheld = 0;
    let cancelGrant: (() => void) | null = null;

    function endStream(): void {
        ended = true;
        scheduled.remove();
        cancelGrant?.();
        onStreamEnd();
    }

    function closeStream(code: CloseCode): void {
        if (ended) return;
        endStream();
        stream.close(code);
    }

    function returnCredit(): void {
        cancelGrant = null;
        const bytes = withheld;
        withheld = 0;
        stream.consumed(bytes);
    }

    function flushed(bytes: number): void {
        if (ended) return;
        withheld += bytes;
        // The bandwidth debt only grows while a grant waits, so the new wait covers the old one.
        const pauseMs = throttle(bytes);
        cancelGrant?.();
        if (pauseMs === 0) returnCredit();
        else cancelGrant = clock.setTimeout(returnCredit, pauseMs);
    }

    const handlers: StreamHandlers = {
        data(bytes) {
            countTraffic('out', bytes.length);
            // After the browser's FIN the stream is about to close; nothing can reach the browser any more.
            if (socket.writableEnded || socket.destroyed) return;
            socket.write(bytes, (error) => {
                if (error == null) flushed(bytes.length);
            });
        },
        drain() {
            scheduled.creditReturned();
        },
        closed(code) {
            endStream();
            if (code === CLOSE_CODE.NORMAL) socket.end();
            else socket.destroy();
        },
    };

    const opened = options.open(handlers);
    if (opened === null) return null;
    const stream = opened;
    const scheduled = scheduler.add(stream);

    function submit(bytes: Uint8Array): void {
        countTraffic('in', bytes.length);
        inFlight = true;
        scheduled.submit(bytes, () => {
            inFlight = false;
            if (browserEnded) closeStream(CLOSE_CODE.NORMAL);
            else socket.resume();
        });
    }

    socket.on('data', (chunk: Buffer) => {
        socket.pause();
        submit(chunk);
    });
    socket.once('end', () => {
        browserEnded = true;
        if (!inFlight) closeStream(CLOSE_CODE.NORMAL);
    });
    socket.once('close', () => {
        // After a clean FIN the last bytes may still be on their way to the engine; `submit` closes the stream then.
        if (!browserEnded) closeStream(CLOSE_CODE.RESET);
    });
    submit(first);

    return {
        bufferedBytes: () => (ended ? 0 : scheduled.pendingBytes() + stream.queuedBytes()) + socket.writableLength,
    };
}
