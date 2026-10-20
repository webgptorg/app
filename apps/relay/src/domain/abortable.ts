/** Settles like `promise`, or rejects with `signal.reason` as soon as `signal` aborts, whichever comes first. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason as Error);
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => {
            reject(signal.reason as Error);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        void promise.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', onAbort);
        });
    });
}
