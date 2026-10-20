import type { Clock } from '../clock';

/** Bytes per turn, about one TLS record, so an SSE event or WebSocket message waits behind at most this much per stream. */
export const SCHEDULER_SLICE_BYTES = 16_384;
/** Above this much queued in the tunnel's WebSocket, no stream of that tunnel sends until it falls below the low mark. */
export const TUNNEL_HIGH_WATER_BYTES = 524_288;
export const TUNNEL_LOW_WATER_BYTES = 131_072;

/** The tunnel stream a scheduled stream writes to (`TunnelStream.write`). */
export interface SchedulerSink {
    /** `false`: out of credit; the rest is queued in the stream, and its `drain` says when credit returns. */
    write(bytes: Uint8Array): boolean;
}

/** The tunnel all scheduled streams share. */
export interface SchedulerTunnel {
    bufferedBytes(): number;
    /** Calls `callback` once, after a flush leaves fewer than `bytes` queued; the result cancels it. */
    whenBufferedBelow(bytes: number, callback: () => void): () => void;
}

export interface StreamSchedulerOptions {
    readonly tunnel: SchedulerTunnel;
    /** Charges bytes to the engine's bandwidth budget; returns how many milliseconds to pause (0: none). */
    readonly throttle: (bytes: number) => number;
    readonly clock: Clock;
}

export interface ScheduledStream {
    /**
     * Queues `bytes` for the stream; `sent` runs once all of them were written within the stream's credit. One batch
     * at a time: submit the next only after `sent`, which is what keeps memory per stream to one batch.
     */
    submit(bytes: Uint8Array, sent: () => void): void;
    /** The stream's `drain`: its credit is back. */
    creditReturned(): void;
    /** Submitted and not yet written to the stream. */
    pendingBytes(): number;
    /** Drops whatever is still queued; `sent` is not called. Idempotent. */
    remove(): void;
}

export interface StreamScheduler {
    add(sink: SchedulerSink): ScheduledStream;
}

interface Entry {
    readonly sink: SchedulerSink;
    pending: Uint8Array | null;
    sent: (() => void) | null;
    blocked: boolean;
}

/**
 * Sends the browser-to-engine bytes of one tunnel's streams in round-robin slices, so one large upload cannot starve
 * another stream's small messages, and stops all of them while the tunnel's WebSocket is backed up or the engine is
 * over its bandwidth budget. A stream's batch counts as sent only once it is within credit, so the caller keeps
 * reading from that browser only while the engine grants credit.
 */
export function createStreamScheduler(options: StreamSchedulerOptions): StreamScheduler {
    const { tunnel, throttle, clock } = options;
    const ready: Entry[] = [];
    let pumping = false;
    let waiting = false;

    // Only called for an entry with a batch in flight, whose `sent` is set.
    function takeSent(entry: Entry): () => void {
        const sent = entry.sent as () => void;
        entry.sent = null;
        return sent;
    }

    function resume(): void {
        waiting = false;
        pump();
    }

    function pump(): void {
        if (pumping || waiting) return;
        pumping = true;
        const done: (() => void)[] = [];
        while (ready.length > 0) {
            if (tunnel.bufferedBytes() >= TUNNEL_HIGH_WATER_BYTES) {
                waiting = true;
                tunnel.whenBufferedBelow(TUNNEL_LOW_WATER_BYTES, resume);
                break;
            }
            const entry = ready.shift() as Entry;
            const pending = entry.pending as Uint8Array;
            const slice = pending.subarray(0, SCHEDULER_SLICE_BYTES);
            entry.pending = pending.length > SCHEDULER_SLICE_BYTES ? pending.subarray(SCHEDULER_SLICE_BYTES) : null;
            // A blocked entry rejoins the ring through `creditReturned`.
            entry.blocked = !entry.sink.write(slice);
            if (!entry.blocked && entry.pending !== null) ready.push(entry);
            if (!entry.blocked && entry.pending === null) done.push(takeSent(entry));
            const pauseMs = throttle(slice.length);
            if (pauseMs > 0) {
                waiting = true;
                clock.setTimeout(resume, pauseMs);
                break;
            }
        }
        pumping = false;
        for (const sent of done) sent();
    }

    return {
        add(sink) {
            const entry: Entry = { sink, pending: null, sent: null, blocked: false };
            return {
                submit(bytes, sent) {
                    // A batch in flight also covers a blocked stream: it stays in flight until its credit returns.
                    if (entry.sent !== null) throw new Error('a batch is already in flight');
                    entry.pending = bytes;
                    entry.sent = sent;
                    ready.push(entry);
                    pump();
                },
                creditReturned() {
                    if (!entry.blocked) return;
                    entry.blocked = false;
                    if (entry.pending !== null) {
                        ready.push(entry);
                        pump();
                    } else {
                        takeSent(entry)();
                    }
                },
                pendingBytes: () => entry.pending?.length ?? 0,
                remove() {
                    const index = ready.indexOf(entry);
                    if (index !== -1) ready.splice(index, 1);
                    entry.pending = null;
                    entry.sent = null;
                    entry.blocked = false;
                },
            };
        },
    };
}
