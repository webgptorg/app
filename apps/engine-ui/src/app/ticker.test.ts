import { describe, expect, it, vi } from 'vitest';

import { createTicker } from './ticker';
import type { TickerVisibility } from './ticker';

function fakeVisibility(): TickerVisibility & { hide(hidden: boolean): void } {
    const listeners = new Set<() => void>();
    const page = {
        visibilityState: 'visible' as DocumentVisibilityState,
        addEventListener: (_: 'visibilitychange', listener: () => void) => listeners.add(listener),
        removeEventListener: (_: 'visibilitychange', listener: () => void) => listeners.delete(listener),
        hide(hidden: boolean) {
            page.visibilityState = hidden ? 'hidden' : 'visible';
            for (const listener of [...listeners]) listener();
        },
    };
    return page;
}

describe('ticker', () => {
    function setup() {
        let now = 1_000;
        const intervals = new Map<number, () => void>();
        let next = 0;
        const visibility = fakeVisibility();
        const ticker = createTicker({
            now: () => now,
            setInterval: (callback) => {
                next += 1;
                intervals.set(next, callback);
                return next;
            },
            clearInterval: (handle) => {
                intervals.delete(handle as number);
            },
            visibility,
        });
        const tick = (ms: number) => {
            now += ms;
            for (const callback of [...intervals.values()]) callback();
        };
        return { ticker, intervals, visibility, tick, setNow: (value: number) => (now = value) };
    }

    it('runs one interval however many components listen, and none without listeners', () => {
        const { ticker, intervals, tick } = setup();
        expect(intervals.size).toBe(0);
        const first = vi.fn();
        const second = vi.fn();
        const stopFirst = ticker.subscribe(first);
        const stopSecond = ticker.subscribe(second);
        expect(intervals.size).toBe(1);
        // Starting delivers one tick at once, so the first frame never shows a stale time.
        first.mockClear();
        second.mockClear();
        tick(1_000);
        expect(ticker.now()).toBe(2_000);
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
        stopFirst();
        expect(intervals.size).toBe(1);
        stopSecond();
        expect(intervals.size).toBe(0);
    });

    it('pauses while the tab is hidden and catches up at once when it shows again', () => {
        const { ticker, intervals, visibility, setNow } = setup();
        const listener = vi.fn();
        ticker.subscribe(listener);
        visibility.hide(true);
        expect(intervals.size).toBe(0);
        setNow(60_000);
        visibility.hide(false);
        expect(intervals.size).toBe(1);
        expect(ticker.now()).toBe(60_000);
        expect(listener).toHaveBeenCalled();
    });
});
