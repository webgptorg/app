import type { Clock } from '../clock';

export interface TokenBucketOptions {
    /** Tokens when full, and how many it starts with. */
    readonly capacity: number;
    readonly refillPerSecond: number;
    readonly clock: Clock;
}

export interface TokenBucket {
    /** Takes `tokens` only if that many are there. */
    tryTake(tokens: number): boolean;
    /**
     * Takes `tokens` even into debt and returns how many milliseconds to wait before the debt is paid off (0: none).
     * For byte budgets, where the bytes are already on their way and the caller can only slow down what follows.
     */
    takeOrWait(tokens: number): number;
    /** Full again: forgetting it now loses nothing. */
    isFull(): boolean;
}

/** Refills continuously from the clock; a clock that steps backwards refills nothing. */
export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
    const { capacity, refillPerSecond, clock } = options;
    if (!(capacity > 0 && refillPerSecond > 0)) throw new RangeError('capacity and refill rate must be positive');
    let tokens = capacity;
    let lastMs = clock.nowMs();

    function refill(): void {
        const nowMs = clock.nowMs();
        if (nowMs > lastMs) tokens = Math.min(capacity, tokens + ((nowMs - lastMs) * refillPerSecond) / 1000);
        lastMs = Math.max(lastMs, nowMs);
    }

    return {
        tryTake(count) {
            refill();
            if (tokens < count) return false;
            tokens -= count;
            return true;
        },
        takeOrWait(count) {
            refill();
            tokens -= count;
            return tokens >= 0 ? 0 : Math.ceil((-tokens * 1000) / refillPerSecond);
        },
        isFull() {
            refill();
            return tokens >= capacity;
        },
    };
}
