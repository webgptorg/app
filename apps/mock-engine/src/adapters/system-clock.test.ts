import { afterEach, describe, expect, it, vi } from 'vitest';

import { systemClock } from './system-clock';

afterEach(() => {
    vi.useRealTimers();
});

describe('systemClock', () => {
    it('reads the wall clock', () => {
        vi.useFakeTimers({ now: 1_700_000_000_000 });
        expect(systemClock.nowMs()).toBe(1_700_000_000_000);
    });

    it('fires a timer once and lets it be cancelled', () => {
        vi.useFakeTimers();
        const fired = vi.fn();
        const cancelled = vi.fn();
        systemClock.setTimeout(fired, 100);
        const cancel = systemClock.setTimeout(cancelled, 100);
        cancel();
        vi.advanceTimersByTime(100);
        expect(fired).toHaveBeenCalledOnce();
        expect(cancelled).not.toHaveBeenCalled();
    });

    it('never keeps the process alive', () => {
        const unref = vi.fn();
        vi.spyOn(globalThis, 'setTimeout').mockReturnValueOnce({ unref } as unknown as NodeJS.Timeout);
        systemClock.setTimeout(() => undefined, 1000);
        expect(unref).toHaveBeenCalledOnce();
        vi.restoreAllMocks();
    });
});
