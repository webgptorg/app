import type { Timer } from '../domain/ports/timer';

export const systemTimer: Timer = {
    wait: (ms, signal) =>
        new Promise((resolve) => {
            if (signal.aborted) {
                resolve();
                return;
            }
            const done = () => {
                clearTimeout(timeout);
                signal.removeEventListener('abort', done);
                resolve();
            };
            const timeout = setTimeout(done, ms);
            signal.addEventListener('abort', done, { once: true });
        }),
};
