import type { LiveChannelClient, LiveChannelEvent } from '../target';

/**
 * A live channel client over any transport: the transport pushes what arrives, the test reads it in order with
 * `next`. Once closed, every read answers the close.
 */
export class LiveChannelQueue implements LiveChannelClient {
    readonly #events: LiveChannelEvent[] = [];
    readonly #waiters = new Set<() => void>();
    #closed: LiveChannelEvent | null = null;
    readonly #send: (data: string | Uint8Array) => void;
    readonly #close: () => void;

    constructor(send: (data: string | Uint8Array) => void, close: () => void) {
        this.#send = send;
        this.#close = close;
    }

    push(event: LiveChannelEvent): void {
        if (this.#closed !== null) return;
        if (event.kind === 'closed') this.#closed = event;
        else this.#events.push(event);
        for (const wake of [...this.#waiters]) wake();
    }

    send(data: string | Uint8Array): void {
        if (this.#closed === null) this.#send(data);
    }

    close(): void {
        if (this.#closed !== null) return;
        this.#close();
        this.push({ kind: 'closed', code: 1000 });
    }

    async next(timeoutMs: number): Promise<LiveChannelEvent | null> {
        const ready = (): LiveChannelEvent | null => this.#events.shift() ?? this.#closed;
        const now = ready();
        if (now !== null) return now;
        return new Promise((resolve) => {
            const finish = (): void => {
                clearTimeout(timer);
                this.#waiters.delete(wake);
                resolve(ready());
            };
            const wake = (): void => {
                finish();
            };
            const timer = setTimeout(finish, timeoutMs);
            this.#waiters.add(wake);
        });
    }
}
