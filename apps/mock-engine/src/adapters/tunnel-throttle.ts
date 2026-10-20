import { Duplex } from 'node:stream';

import type { Clock } from '../domain/clock';

export interface ThrottleDeps {
    readonly clock: Clock;
    /** Read before every slice, so a fault plan change applies mid-transfer; `null` passes bytes straight through. */
    readonly bytesPerS: () => number | null;
}

/** Bytes are released in slices of this much time's worth, so pacing stays smooth without a timer per byte. */
const SLICE_MS = 50;

/**
 * Wraps a tunnel stream to simulate a slow tunnel (`slowTunnelBytesPerS`): bytes the engine writes reach the tunnel no
 * faster than the configured rate. Bytes from the browser pass through untouched. A write completes only once all of
 * it is through, so the writer feels the slowness as ordinary backpressure.
 */
export function throttleDuplex(inner: Duplex, deps: ThrottleDeps): Duplex {
    let cancelTimer: (() => void) | undefined;

    const outer = new Duplex({
        read() {
            inner.resume();
        },
        write(chunk: Buffer, _encoding, callback) {
            let offset = 0;
            const forward = (): void => {
                cancelTimer = undefined;
                if (outer.destroyed) {
                    callback();
                    return;
                }
                const rate = deps.bytesPerS();
                const sliceBytes =
                    rate === null ? chunk.length - offset : Math.max(1, Math.floor((rate * SLICE_MS) / 1000));
                const slice = chunk.subarray(offset, offset + sliceBytes);
                offset += slice.length;
                const afterSlice = (): void => {
                    // Unthrottled, the slice was the whole remainder.
                    if (rate === null) {
                        callback();
                        return;
                    }
                    const done = offset >= chunk.length;
                    cancelTimer = deps.clock.setTimeout(done ? callback : forward, (slice.length * 1000) / rate);
                };
                if (inner.write(slice)) afterSlice();
                else inner.once('drain', afterSlice);
            };
            forward();
        },
        final(callback) {
            inner.end();
            callback();
        },
        destroy(error, callback) {
            cancelTimer?.();
            cancelTimer = undefined;
            inner.destroy(error ?? undefined);
            callback(error);
        },
    });

    inner.on('data', (chunk: Buffer) => {
        if (!outer.push(chunk)) inner.pause();
    });
    inner.once('end', () => outer.push(null));
    inner.once('error', (error) => outer.destroy(error));
    inner.once('close', () => {
        if (!outer.destroyed) outer.destroy();
    });
    return outer;
}
