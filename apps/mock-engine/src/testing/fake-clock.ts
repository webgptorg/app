import type { Clock } from '../domain/clock';

export interface FakeClock extends Clock {
    /** Moves time forward, firing every timer that falls due, in order. */
    advance(ms: number): void;
    /** Timers scheduled and not yet fired or cancelled. */
    pendingTimers(): number;
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
    };
}
