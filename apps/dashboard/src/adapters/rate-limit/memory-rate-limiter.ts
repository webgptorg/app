import type { Clock } from '../../domain/ports/clock';
import { RATE_LIMITS, type RateLimiter } from '../../domain/ports/rate-limiter';
import { countAttempt, type WindowState } from './fixed-window';

/** In-process fixed windows for dev and tests; expired windows are dropped on every call. */
export function createMemoryRateLimiter(clock: Clock): RateLimiter {
    const windows = new Map<string, WindowState & { readonly windowMs: number }>();
    return {
        consume(rule, key) {
            const now = clock.nowMs();
            for (const [id, window] of windows) {
                if (now >= window.start + window.windowMs) {
                    windows.delete(id);
                }
            }
            const id = `${rule}\0${key}`;
            const decision = countAttempt(windows.get(id) ?? null, RATE_LIMITS[rule], now);
            if (decision.kind === 'limited') {
                return Promise.resolve('limited');
            }
            windows.set(id, { ...decision.state, windowMs: RATE_LIMITS[rule].windowMs });
            return Promise.resolve('allowed');
        },
    };
}
