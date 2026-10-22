import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';

/** Callbacks a real socket would run on a later tick, run only when the test says so. */
export interface FakeEventLoop {
    defer(run: () => void): void;
    /** Runs deferred callbacks, including ones they defer, until none is left. */
    runUntilIdle(): void;
}

/** More callbacks than any test schedules: past it, something keeps rescheduling itself. */
const MAX_TICKS = 1_000_000;

export function createFakeEventLoop(): FakeEventLoop {
    const queue: (() => void)[] = [];
    return {
        defer(run) {
            queue.push(run);
        },
        runUntilIdle() {
            for (let ticks = 0; queue.length > 0; ticks++) {
                if (ticks === MAX_TICKS) throw new Error('the event loop never went idle');
                (queue.shift() as () => void)();
            }
        },
    };
}

interface PendingWrite {
    remaining: number;
    readonly callback: ((error?: Error | null) => void) | undefined;
}

/** The browser's end of a {@link FakeSocket}. */
export interface FakeBrowser {
    /** Sends a chunk; the relay sees it as one `data` event once it reads. */
    send(chunk: Uint8Array): void;
    /** Reads up to `bytes` of what the relay wrote; returns how many it read. */
    read(bytes: number): number;
    /** Half-closes: the relay sees `end` after the data before it. */
    fin(): void;
    /** Goes away without a FIN, as a reset or a vanished peer would. */
    vanish(): void;
}

/**
 * The relay's side of a browser TCP connection, enough for `pipeSocketToStream`: it starts paused (`pauseOnConnect`),
 * emits `data` only while flowing, `end` once the data before the FIN was emitted, ends its writable side when the browser's FIN arrives (no `allowHalfOpen`), runs
 * write callbacks once the browser read the bytes, and fails pending writes on `destroy`. Events go through `loop`.
 */
export interface FakeSocket {
    readonly socket: Socket;
    readonly browser: FakeBrowser;
    isClosed(): boolean;
    /** The browser half-closed before the socket closed. */
    sawFin(): boolean;
}

export function createFakeSocket(loop: FakeEventLoop): FakeSocket {
    const emitter = new EventEmitter();
    const incoming: Uint8Array[] = [];
    const writes: PendingWrite[] = [];
    let paused = true;
    let flowScheduled = false;
    let finReceived = false;
    let endEmitted = false;
    let writableLength = 0;
    let writableEnded = false;
    let destroyed = false;
    let closeEmitted = false;

    function emitClose(): void {
        if (closeEmitted) return;
        closeEmitted = true;
        loop.defer(() => emitter.emit('close', false));
    }

    function closeIfDone(): void {
        if (endEmitted && writableEnded && writableLength === 0) emitClose();
    }

    function scheduleFlow(): void {
        if (flowScheduled) return;
        flowScheduled = true;
        loop.defer(flow);
    }

    function flow(): void {
        flowScheduled = false;
        while (!paused && !destroyed && incoming.length > 0) {
            emitter.emit('data', Buffer.from(incoming.shift() as Uint8Array));
        }
        // As in Node, `end` follows the last `data` even while paused.
        if (!destroyed && finReceived && incoming.length === 0 && !endEmitted) {
            endEmitted = true;
            emitter.emit('end');
            end();
        }
    }

    function end(): Socket {
        writableEnded = true;
        closeIfDone();
        return socket;
    }

    function destroy(): Socket {
        if (destroyed) return socket;
        destroyed = true;
        for (const write of writes.splice(0)) {
            loop.defer(() => write.callback?.(new Error('socket destroyed')));
        }
        writableLength = 0;
        emitClose();
        return socket;
    }

    // Getters, not copied values: `Object.assign` would read them once.
    Object.defineProperties(emitter, {
        writableLength: { get: () => writableLength },
        writableEnded: { get: () => writableEnded },
        destroyed: { get: () => destroyed },
    });
    const socket = Object.assign(emitter, {
        pause() {
            paused = true;
            return socket;
        },
        resume() {
            paused = false;
            scheduleFlow();
            return socket;
        },
        write(chunk: Uint8Array, callback?: (error?: Error | null) => void) {
            if (destroyed || writableEnded) throw new Error('write after the socket ended');
            writes.push({ remaining: chunk.length, callback });
            writableLength += chunk.length;
            return true;
        },
        end,
        destroy,
    }) as unknown as Socket;

    return {
        socket,
        isClosed: () => closeEmitted,
        sawFin: () => finReceived,
        browser: {
            send(chunk) {
                if (destroyed || finReceived) return;
                incoming.push(chunk);
                if (!paused) scheduleFlow();
            },
            read(bytes) {
                let read = 0;
                while (read < bytes && writes.length > 0) {
                    const write = writes[0] as PendingWrite;
                    const part = Math.min(write.remaining, bytes - read);
                    write.remaining -= part;
                    writableLength -= part;
                    read += part;
                    if (write.remaining === 0) {
                        writes.shift();
                        loop.defer(() => write.callback?.(null));
                    }
                }
                closeIfDone();
                return read;
            },
            fin() {
                if (destroyed || finReceived) return;
                finReceived = true;
                scheduleFlow();
            },
            vanish: destroy,
        },
    };
}
