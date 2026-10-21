import { act } from '@testing-library/react';

import { createTicker } from '../app/ticker';
import type { Ticker } from '../app/ticker';

export interface ManualTicker extends Ticker {
    /** Moves the clock and delivers one tick, as the interval would. */
    advance(ms: number): void;
    /** How many intervals are running; the app shares one. */
    readonly running: () => number;
}

/** The app's ticker on a clock and interval the test drives, so live durations need no real time. */
export function createManualTicker(startMs: number): ManualTicker {
    let now = startMs;
    const callbacks = new Map<number, () => void>();
    let next = 0;
    const ticker = createTicker({
        now: () => now,
        setInterval: (callback) => {
            next += 1;
            callbacks.set(next, callback);
            return next;
        },
        clearInterval: (handle) => {
            callbacks.delete(handle as number);
        },
    });
    return {
        ...ticker,
        advance(ms) {
            now += ms;
            act(() => {
                for (const callback of [...callbacks.values()]) callback();
            });
        },
        running: () => callbacks.size,
    };
}
