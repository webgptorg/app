import type { Clock } from '../domain/clock';

export const systemClock: Clock = {
    nowMs: () => Date.now(),
    setTimeout(fn, ms) {
        const timer = setTimeout(fn, ms);
        // Timers bound I/O and schedule reconnects; only open sockets keep the engine running.
        timer.unref();
        return () => {
            clearTimeout(timer);
        };
    },
};
