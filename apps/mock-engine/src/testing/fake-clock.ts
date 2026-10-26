import type { Clock } from '../domain/clock';

export interface FakeClock extends Clock {
    /** Moves time forward, firing every timer that falls due, in order. */
    advance(ms: number): void;
    /** Timers scheduled and not yet fired or cancelled. */
    pendingTimers(): number;
    /** Milliseconds until the next timer is due, or null when none is scheduled. */
    nextTimerInMs(): number | null;
}

interface Timer {
    readonly id: number;
    readonly dueMs: number;
    readonly fn: () => void;
}

export function createFakeClock(startMs = 0): FakeClock {
    let nowMs = startMs;
    let nextId = 0;
    const timers = new Map<number, Timer>();

    function nextDue(untilMs: number): Timer | undefined {
        let next: Timer | undefined;
        for (const timer of timers.values()) {
            if (timer.dueMs <= untilMs && (next === undefined || timer.dueMs < next.dueMs)) next = timer;
        }
        return next;
    }

    return {
        nowMs: () => nowMs,
        setTimeout(fn, ms) {
            const id = nextId++;
            timers.set(id, { id, dueMs: nowMs + Math.max(0, ms), fn });
            return () => {
                timers.delete(id);
            };
        },
        advance(ms) {
            const untilMs = nowMs + ms;
            for (let timer = nextDue(untilMs); timer !== undefined; timer = nextDue(untilMs)) {
                timers.delete(timer.id);
                nowMs = timer.dueMs;
                timer.fn();
            }
            nowMs = untilMs;
        },
        pendingTimers: () => timers.size,
        nextTimerInMs: () => {
            const next = nextDue(Infinity);
            return next === undefined ? null : next.dueMs - nowMs;
        },
    };
}

/**
 * Awaits `promise`, moving the clock to each timer it waits on in turn, so code that backs off for minutes settles at
 * once. Fails when the promise is stuck on something other than this clock.
 */
export async function settleWithClock<T>(promise: Promise<T>, clock: FakeClock, maxSteps = 1_000): Promise<T> {
    const state = { settled: false };
    const tracked = promise.finally(() => {
        state.settled = true;
    });
    // Handled here so a rejection while the clock moves is not reported as unhandled; the caller still gets it.
    tracked.catch(() => undefined);
    for (let step = 0; step < maxSteps; step++) {
        // Bounded by wall time, not turns: WebCrypto signs off the event loop.
        const deadline = performance.now() + 5_000;
        while (!state.settled && clock.nextTimerInMs() === null && performance.now() < deadline) {
            await new Promise<void>((resolve) => {
                setImmediate(resolve);
            });
        }
        if (state.settled) return tracked;
        const next = clock.nextTimerInMs();
        if (next === null) throw new Error('the promise waits on something other than the fake clock');
        clock.advance(next);
    }
    throw new Error('the promise did not settle');
}
