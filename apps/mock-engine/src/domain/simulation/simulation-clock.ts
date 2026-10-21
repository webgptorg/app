import type { Clock } from '../clock';

export type SimulationMode = 'running' | 'paused';

export const MIN_SIMULATION_SPEED = 0.1;
export const MAX_SIMULATION_SPEED = 3600;

/**
 * The engine's own time. Running, it moves `speed` times as fast as the real clock; paused, it stands still and moves
 * only by `advance`, which fires every timer that falls due in order, so a test or e2e run drives time exactly.
 * Timers are kept here and only the earliest is handed to the real clock, so real timers stay in its adapter.
 */
export interface SimulationClock extends Clock {
    mode(): SimulationMode;
    speed(): number;
    set(mode: SimulationMode, speed?: number): void;
    /** Only while paused; throws while running, where real time moves the clock. */
    advance(ms: number): void;
    /** Cancels every timer and starts again at `startMs`, in the current mode. */
    reset(startMs: number): void;
}

interface Timer {
    readonly dueMs: number;
    /** Ties fire in the order they were scheduled. */
    readonly order: number;
    readonly fn: () => void;
}

export function createSimulationClock(options: {
    readonly real: Clock;
    readonly mode: SimulationMode;
    readonly speed: number;
    readonly startMs: number;
}): SimulationClock {
    const { real } = options;
    let mode = options.mode;
    let speed = options.speed;
    let baseMs = options.startMs;
    let realBaseMs = real.nowMs();
    let order = 0;
    const timers = new Map<number, Timer>();
    let cancelReal: (() => void) | null = null;
    let armedForMs = 0;

    const nowMs = (): number => (mode === 'running' ? baseMs + (real.nowMs() - realBaseMs) * speed : baseMs);

    function earliest(untilMs = Infinity): [number, Timer] | undefined {
        let found: [number, Timer] | undefined;
        for (const entry of timers) {
            const [, timer] = entry;
            if (timer.dueMs > untilMs) continue;
            if (
                found === undefined ||
                timer.dueMs < found[1].dueMs ||
                (timer.dueMs === found[1].dueMs && timer.order < found[1].order)
            ) {
                found = entry;
            }
        }
        return found;
    }

    function arm(): void {
        cancelReal?.();
        cancelReal = null;
        const next = earliest();
        if (mode !== 'running' || next === undefined) return;
        armedForMs = next[1].dueMs;
        cancelReal = real.setTimeout(fireDue, Math.max(0, (armedForMs - nowMs()) / speed));
    }

    function fireDue(): void {
        cancelReal = null;
        // Scaling real time by the speed is not exact in floating point; the real timer fired for `armedForMs`, so
        // simulated time has reached it, and is moved there if rounding left it a hair short.
        if (nowMs() < armedForMs) baseMs += armedForMs - nowMs();
        for (let next = earliest(nowMs()); next !== undefined; next = earliest(nowMs())) {
            timers.delete(next[0]);
            next[1].fn();
        }
        arm();
    }

    function rebase(): void {
        baseMs = nowMs();
        realBaseMs = real.nowMs();
    }

    return {
        nowMs,
        mode: () => mode,
        speed: () => speed,
        setTimeout(fn, ms) {
            const id = order++;
            timers.set(id, { dueMs: nowMs() + Math.max(0, ms), order: id, fn });
            arm();
            return () => {
                if (timers.delete(id)) arm();
            };
        },
        set(nextMode, nextSpeed = speed) {
            if (!(nextSpeed > 0) || !Number.isFinite(nextSpeed)) throw new RangeError('speed must be positive');
            rebase();
            mode = nextMode;
            speed = nextSpeed;
            arm();
        },
        advance(ms) {
            if (mode !== 'paused') throw new Error('advance needs a paused simulation');
            if (!(ms >= 0) || !Number.isFinite(ms)) throw new RangeError('ms must not be negative');
            const untilMs = baseMs + ms;
            for (let next = earliest(untilMs); next !== undefined; next = earliest(untilMs)) {
                timers.delete(next[0]);
                baseMs = Math.max(baseMs, next[1].dueMs);
                next[1].fn();
            }
            baseMs = untilMs;
        },
        reset(startMs) {
            timers.clear();
            baseMs = startMs;
            realBaseMs = real.nowMs();
            arm();
        },
    };
}
