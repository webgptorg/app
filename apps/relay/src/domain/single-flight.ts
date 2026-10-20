export interface SingleFlight<K, V> {
    /** Joins the call already running for `key`, or starts one with `start`. */
    run(key: K, start: () => Promise<V>): Promise<V>;
}

export function createSingleFlight<K, V>(): SingleFlight<K, V> {
    const inFlight = new Map<K, Promise<V>>();
    return {
        run(key, start) {
            const running = inFlight.get(key);
            if (running !== undefined) return running;
            const started = start().finally(() => {
                inFlight.delete(key);
            });
            inFlight.set(key, started);
            return started;
        },
    };
}
