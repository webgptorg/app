import type { Clock } from '../domain/clock';

export const systemClock: Clock = {
    nowMs: () => Date.now(),
    setTimeout(fn, ms) {
        const timer = setTimeout(fn, ms);
        // Timers bound I/O; only listeners and connections keep the relay running.
        timer.unref();
        return () => {
            clearTimeout(timer);
        };
    },
};
