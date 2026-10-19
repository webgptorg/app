import type { Clock } from '../domain/ports/clock';

export interface FakeClock extends Clock {
    set(nowMs: number): void;
    advance(ms: number): void;
}

export function createFakeClock(startMs = 0): FakeClock {
    let now = startMs;
    return {
        nowMs: () => now,
        set: (nowMs) => {
            now = nowMs;
        },
        advance: (ms) => {
            now += ms;
        },
    };
}
