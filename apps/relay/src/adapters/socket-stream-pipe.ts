import type { Socket } from 'node:net';

import type { CloseCode } from '@ptbk/protocol';
import { CLOSE_CODE, INITIAL_WINDOW_BYTES } from '@ptbk/protocol';

import type { Clock } from '../domain/clock';
import type { MemoryBudget } from '../domain/limits/memory-budget';
import { createMemoryCharge } from '../domain/limits/memory-budget';
import type { StreamResetReason } from '../domain/metrics/reason-counters';
import type { TrafficDirection } from '../domain/metrics/traffic-counters';
import type { StreamScheduler } from '../domain/routing/stream-scheduler';
import type { StreamHandlers, TunnelStream } from '../domain/tunnel/tunnel-session';

/** The most a stream holds towards the engine: one read from its socket, which libuv makes at most 64 KiB at a time. */
export const READ_RESERVE_BYTES = 65_536;
/** What each open stream reserves in the memory budget: its whole window towards the browser and one read. */
export const STREAM_RESERVE_BYTES = INITIAL_WINDOW_BYTES + READ_RESERVE_BYTES;

export interface StreamLimits {
    /** `RELAY_STREAM_FIRST_BYTE_TIMEOUT_MS`: from `OPEN` until the engine's first DATA. */
    readonly firstByteTimeoutMs: number;
    /** `RELAY_STREAM_DRAIN_TIMEOUT_MS`: after the browser's FIN, until its last bytes are within the engine's credit. */
    readonly drainTimeoutMs: number;
    /** `RELAY_STREAM_END_TIMEOUT_MS`: after the stream ended, until the socket has flushed and closed. */
    readonly endTimeoutMs: number;
}

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
    readonly limits: StreamLimits;
    /** Each open stream reserves `STREAM_RESERVE_BYTES`; over budget, the pipe stops reading the browser. */
    readonly memory: MemoryBudget;
    readonly countReset: (reason: StreamResetReason) => void;
    /** Called once, when the stream ends from either side. */
    readonly onStreamEnd: () => void;
    /** Called once, when the stream has ended and the socket has closed: nothing is held for the connection any more. */
    readonly onDone: () => void;
    /** A handler threw: a bug. The pipe has reset the stream and destroyed the socket; the caller closes the tunnel. */
    readonly onFailure: (error: unknown) => void;
}

export interface SocketStreamPipe {
    /** Bytes held for this connection: queued for the engine, or written to the browser and not yet flushed. */
    readonly bufferedBytes: () => number;
}

/**
 * Pipes a browser socket into a tunnel stream without looking at the bytes. Browser to engine: the socket is read one
 * chunk at a time and only while the stream has credit. Engine to browser: credit goes back to the engine only once
 * the socket has flushed the bytes, so a browser that stops reading holds at most one window here. Either side
 * closing ends the other; a reset ends both at once. Every wait is bounded: the engine's first byte, the browser's
 * last bytes after its FIN, and the socket's flush after the stream ended each have a deadline.
 */
export function pipeSocketToStream(options: SocketStreamPipeOptions): SocketStreamPipe | null {
    const { socket, first, scheduler, throttle, countTraffic, clock, limits, memory } = options;
    const { countReset, onStreamEnd, onDone, onFailure } = options;
    const charge = createMemoryCharge(memory);
    let ended = false;
    let socketClosed = false;
    let browserEnded = false;
    let inFlight = false;
    let withheld = 0;
    let cancelGrant: (() => void) | null = null;
    let cancelReading: (() => void) | null = null;
    let cancelFirstByte: (() => void) | null = null;
    let cancelDrain: (() => void) | null = null;
    let cancelEnd: (() => void) | null = null;
    let done = false;

    function guard(run: () => void): void {
        try {
            run();
        } catch (error) {
            countReset('failed');
            try {
                closeStream(CLOSE_CODE.RESET);
            } catch {
                // The state is already broken; the caller closes the whole tunnel below.
            }
            socket.destroy();
            onFailure(error);
        }
    }

    const after = (ms: number, run: () => void): (() => void) =>
        clock.setTimeout(() => {
            guard(run);
        }, ms);

    function bufferedBytes(): number {
        return (
            (ended ? 0 : scheduled.pendingBytes() + stream.queuedBytes()) + (socketClosed ? 0 : socket.writableLength)
        );
    }

    // An open stream is charged the most it can come to hold, not what it holds now: towards the browser the credit it
    // granted, towards the engine one read. So credit can always be returned and reading never pushes the budget over,
    // and browsers that stop reading fill the budget only with their own reservations: new streams are refused, but
    // they cannot stall the streams of browsers that read. After the stream ended, only what is left counts.
    function sync(): void {
        const towardEngine = ended ? 0 : scheduled.pendingBytes() + stream.queuedBytes();
        if (socketClosed) charge.set(towardEngine);
        else if (ended) charge.set(socket.writableLength);
        else charge.set(INITIAL_WINDOW_BYTES + Math.max(READ_RESERVE_BYTES, towardEngine));
    }

    function finishIfDone(): void {
        if (done || !ended || !socketClosed) return;
        done = true;
        cancelEnd?.();
        onDone();
    }

    // After the stream ended nothing more goes to the engine: whatever the browser still sends is read and dropped, so
    // its FIN (or the end timeout) can release the socket.
    function discardInput(): void {
        socket.removeAllListeners('data');
        socket.on('data', () => undefined);
        socket.resume();
    }

    function endStream(): void {
        ended = true;
        scheduled.remove();
        for (const cancel of [cancelGrant, cancelReading, cancelFirstByte, cancelDrain]) cancel?.();
        onStreamEnd();
        if (!socketClosed) {
            discardInput();
            cancelEnd = after(limits.endTimeoutMs, () => {
                countReset('end-timeout');
                socket.destroy();
            });
        }
        sync();
        finishIfDone();
    }

    function closeStream(code: CloseCode): void {
        if (ended) return;
        endStream();
        stream.close(code);
    }

    function reset(reason: StreamResetReason): void {
        countReset(reason);
        closeStream(CLOSE_CODE.RESET);
        socket.destroy();
    }

    function returnCredit(): void {
        cancelGrant = null;
        const bytes = withheld;
        withheld = 0;
        stream.consumed(bytes);
    }

    function flushed(bytes: number): void {
        sync();
        if (ended) return;
        withheld += bytes;
        // The bandwidth debt only grows while a grant waits, so the new wait covers the old one.
        const pauseMs = throttle(bytes);
        cancelGrant?.();
        if (pauseMs === 0) returnCredit();
        else cancelGrant = after(pauseMs, returnCredit);
    }

    function resumeReading(): void {
        cancelReading = null;
        if (memory.isOver()) {
            cancelReading = memory.whenRelieved(() => {
                guard(resumeReading);
            });
            return;
        }
        socket.resume();
    }

    const handlers: StreamHandlers = {
        data(bytes) {
            cancelFirstByte?.();
            cancelFirstByte = null;
            countTraffic('out', bytes.length);
            // After the browser's FIN the stream is about to close; nothing can reach the browser any more.
            if (socket.writableEnded || socket.destroyed) return;
            socket.write(bytes, (error) => {
                guard(() => {
                    if (error == null) flushed(bytes.length);
                    else sync();
                });
            });
            sync();
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
            guard(() => {
                inFlight = false;
                if (browserEnded) closeStream(CLOSE_CODE.NORMAL);
                else resumeReading();
                sync();
            });
        });
        sync();
    }

    socket.on('data', (chunk: Buffer) => {
        guard(() => {
            socket.pause();
            submit(chunk);
        });
    });
    socket.once('end', () => {
        guard(() => {
            browserEnded = true;
            if (ended) return;
            if (inFlight) {
                cancelDrain = after(limits.drainTimeoutMs, () => {
                    reset('drain-timeout');
                });
            } else {
                closeStream(CLOSE_CODE.NORMAL);
            }
        });
    });
    socket.once('close', () => {
        guard(() => {
            socketClosed = true;
            // After a clean FIN the last bytes may still be on their way to the engine; `submit` closes the stream then.
            if (!browserEnded) closeStream(CLOSE_CODE.RESET);
            sync();
            finishIfDone();
        });
    });
    cancelFirstByte = after(limits.firstByteTimeoutMs, () => {
        reset('first-byte-timeout');
    });
    submit(first);
    return { bufferedBytes };
}
