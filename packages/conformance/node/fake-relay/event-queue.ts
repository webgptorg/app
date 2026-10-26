/** What `next` gives back when nothing arrived in time; never an event itself. */
export const TIMED_OUT = Symbol('timed out');

/**
 * Events in arrival order, for checks that script a peer step by step. Unread events stay queued, so a check never
 * misses one that arrived before it started waiting.
 */
export class EventQueue<T> {
    readonly #items: T[] = [];
    readonly #waiters = new Set<(item: T) => void>();

    push(item: T): void {
        const [waiter] = this.#waiters;
        if (waiter === undefined) {
            this.#items.push(item);
            return;
        }
        this.#waiters.delete(waiter);
        waiter(item);
    }

    /** The next event, or `TIMED_OUT` after `timeoutMs`; rejects when `signal` aborts. */
    next(timeoutMs: number, signal?: AbortSignal): Promise<T | typeof TIMED_OUT> {
        const queued = this.#items.shift();
        if (queued !== undefined) return Promise.resolve(queued);
        return new Promise((resolve, reject) => {
            const finish = (value: T | typeof TIMED_OUT): void => {
                clearTimeout(timer);
                this.#waiters.delete(take);
                signal?.removeEventListener('abort', onAbort);
                resolve(value);
            };
            const take = (item: T): void => {
                finish(item);
            };
            const onAbort = (): void => {
                clearTimeout(timer);
                this.#waiters.delete(take);
                reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
            };
            const timer = setTimeout(() => {
                finish(TIMED_OUT);
            }, timeoutMs);
            if (signal?.aborted === true) {
                onAbort();
                return;
            }
            signal?.addEventListener('abort', onAbort, { once: true });
            this.#waiters.add(take);
        });
    }

    /** Skips events until one matches; `TIMED_OUT` when none does within `timeoutMs` overall. */
    async find(match: (item: T) => boolean, timeoutMs: number, signal?: AbortSignal): Promise<T | typeof TIMED_OUT> {
        const deadline = performance.now() + timeoutMs;
        for (;;) {
            const left = deadline - performance.now();
            if (left <= 0) return TIMED_OUT;
            const item = await this.next(left, signal);
            if (item === TIMED_OUT || match(item)) return item;
        }
    }

    drain(): T[] {
        return this.#items.splice(0);
    }
}
