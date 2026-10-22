import type { Timer } from '../domain/ports/timer';

/** A {@link Timer} whose waits end only when the test says so (`elapse`) or their signal aborts. */
export interface ManualTimer extends Timer {
    /** Ends every wait still pending. */
    elapse(): void;
    /** Waits neither elapsed nor aborted yet. */
    pending(): number;
}

export function createManualTimer(): ManualTimer {
    const waiting = new Set<() => void>();
    return {
        wait: (_ms, signal) =>
            new Promise((resolve) => {
                if (signal.aborted) {
                    resolve();
                    return;
                }
                const done = () => {
                    waiting.delete(done);
                    signal.removeEventListener('abort', done);
                    resolve();
                };
                waiting.add(done);
                signal.addEventListener('abort', done, { once: true });
            }),
        elapse() {
            for (const done of [...waiting]) {
                done();
            }
        },
        pending: () => waiting.size,
    };
}
