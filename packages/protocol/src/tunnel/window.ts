import { MAX_WINDOW_INCREMENT } from './frame';

/** Most credit a window may hold, as in HTTP/2: a grant past it is a flow-control violation, not a wrap-around. */
export const MAX_WINDOW_BYTES = MAX_WINDOW_INCREMENT;

export type WindowUpdate = { readonly kind: 'ok' } | { readonly kind: 'violation' };

/** Pure credit accounting for one direction of one stream, counted in DATA payload bytes. */
export interface FlowWindow {
    /** `violation` (credit unchanged) when `bytes` exceeds the credit. */
    consume(bytes: number): WindowUpdate;
    /** `violation` (credit unchanged) when the credit would exceed `MAX_WINDOW_BYTES`. */
    grant(bytes: number): WindowUpdate;
    available(): number;
}

const OK: WindowUpdate = Object.freeze({ kind: 'ok' });
const VIOLATION: WindowUpdate = Object.freeze({ kind: 'violation' });

function assertCount(bytes: number, min: number): void {
    // Counts come from decoded frames or the caller's own sizes; anything else is a bug, not peer input.
    if (!Number.isSafeInteger(bytes) || bytes < min || bytes > MAX_WINDOW_BYTES) {
        throw new RangeError(`byte count must be an integer in ${String(min)}..${String(MAX_WINDOW_BYTES)}`);
    }
}

function createWindow(initial: number): FlowWindow {
    assertCount(initial, 0);
    let credit = initial;
    return {
        consume(bytes) {
            assertCount(bytes, 1);
            if (bytes > credit) return VIOLATION;
            credit -= bytes;
            return OK;
        },
        grant(bytes) {
            assertCount(bytes, 1);
            if (bytes > MAX_WINDOW_BYTES - credit) return VIOLATION;
            credit += bytes;
            return OK;
        },
        available: () => credit,
    };
}

/**
 * What this side may still send on a stream. `consume` before sending DATA (`violation` means wait for `WINDOW`);
 * `grant` for each `WINDOW` received (`violation` means the peer over-granted: close the stream with `FLOW_CONTROL`).
 */
export function createSendWindow(initial: number): FlowWindow {
    return createWindow(initial);
}

/**
 * What the peer may still send on a stream. `consume` for each DATA received (`violation` means the peer sent beyond
 * its credit: close the stream with `FLOW_CONTROL`); `grant` after delivering bytes downstream, then send `WINDOW`.
 */
export function createReceiveWindow(initial: number): FlowWindow {
    return createWindow(initial);
}
