import type { Clock } from '../../domain/ports/clock';
import { RATE_LIMITS, type RateLimiter, type RateLimitRules } from '../../domain/ports/rate-limiter';
import { countAttempt, type WindowState } from './fixed-window';

/** The counters, kept apart from the limiter so dev can build a limiter per request over state that outlives it. */
export type MemoryRateLimitWindows = Map<string, WindowState & { readonly windowMs: number }>;

/** In-process fixed windows for dev and tests; expired windows are dropped on every call. */
export function createMemoryRateLimiter(
    clock: Clock,
    rules: RateLimitRules = RATE_LIMITS,
    windows: MemoryRateLimitWindows = new Map(),
): RateLimiter {
    return {
        consume(rule, key) {
            const now = clock.nowMs();
            for (const [id, window] of windows) {
                if (now >= window.start + window.windowMs) {
                    windows.delete(id);
                }
            }
            const id = `${rule}\0${key}`;
            const decision = countAttempt(windows.get(id) ?? null, rules[rule], now);
            if (decision.kind === 'limited') {
                return Promise.resolve('limited');
            }
            windows.set(id, { ...decision.state, windowMs: rules[rule].windowMs });
            return Promise.resolve('allowed');
        },
    };
}
