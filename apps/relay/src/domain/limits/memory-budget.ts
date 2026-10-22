export interface MemoryBudget {
    /** Adds bytes held or reserved (a negative delta frees them); wakes the waiters once usage is back in budget. */
    adjust(deltaBytes: number): void;
    used(): number;
    /** More held than `RELAY_MEMORY_BUDGET_BYTES`: stop taking more in. */
    isOver(): boolean;
    /** `bytes` more would still fit. */
    hasRoomFor(bytes: number): boolean;
    /** Calls `callback` once, when usage is next back within the budget; the result cancels it. */
    whenRelieved(callback: () => void): () => void;
}

/** One holder's share of the budget, so it can report its current size rather than every change. */
export interface MemoryCharge {
    /** What the holder holds now; `set(0)` when it is gone. */
    set(bytes: number): void;
}

/**
 * One relay-wide budget over every byte the relay holds, or has let an engine make it hold, for someone else. Waiters
 * wake as soon as usage is back within the budget, not at a lower mark: reservations may keep usage close to the
 * budget for as long as streams stay open, and a lower mark could then never be reached.
 */
export function createMemoryBudget(limitBytes: number): MemoryBudget {
    const waiters = new Set<() => void>();
    let used = 0;

    return {
        adjust(delta) {
            used += delta;
            if (delta >= 0 || used > limitBytes || waiters.size === 0) return;
            const woken = [...waiters];
            waiters.clear();
            for (const callback of woken) callback();
        },
        used: () => used,
        isOver: () => used > limitBytes,
        hasRoomFor: (bytes) => used + bytes <= limitBytes,
        whenRelieved(callback) {
            const waiter = (): void => {
                callback();
            };
            waiters.add(waiter);
            return () => {
                waiters.delete(waiter);
            };
        },
    };
}

export function createMemoryCharge(budget: MemoryBudget): MemoryCharge {
    let charged = 0;
    return {
        set(bytes) {
            if (bytes === charged) return;
            budget.adjust(bytes - charged);
            charged = bytes;
        },
    };
}
