import type { Clock } from './clock';

export type TimedOutcome<T> =
    { readonly kind: 'done'; readonly value: T } | { readonly kind: 'timeout' } | { readonly kind: 'threw' };

/**
 * Never rejects: a throw or a timeout becomes an outcome. On timeout the call's signal aborts, so the adapter can stop
 * its I/O, and whatever it returns later is ignored.
 */
export function callWithTimeout<T>(
    clock: Clock,
    timeoutMs: number,
    call: (signal: AbortSignal) => Promise<T>,
): Promise<TimedOutcome<T>> {
    const controller = new AbortController();
    return new Promise((resolve) => {
        const cancel = clock.setTimeout(() => {
            controller.abort(new DOMException('timed out', 'TimeoutError'));
            resolve({ kind: 'timeout' });
        }, timeoutMs);
        const settle = (outcome: TimedOutcome<T>): void => {
            cancel();
            resolve(outcome);
        };
        Promise.resolve()
            .then(() => call(controller.signal))
            .then(
                (value) => {
                    settle({ kind: 'done', value });
                },
                () => {
                    settle({ kind: 'threw' });
                },
            );
    });
}
