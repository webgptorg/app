import type { RateLimitRule } from '../../domain/ports/rate-limiter';

export interface WindowState {
    /** Milliseconds since the Unix epoch at which this window started. */
    readonly start: number;
    readonly count: number;
}

export type WindowDecision =
    | { readonly kind: 'allowed'; readonly state: WindowState; readonly newWindow: boolean }
    | { readonly kind: 'limited' };

/** A fixed window: at most `limit` attempts from the first attempt until `windowMs` later, then a fresh window. */
export function countAttempt(state: WindowState | null, rule: RateLimitRule, now: number): WindowDecision {
    if (state === null || now >= state.start + rule.windowMs) {
        return { kind: 'allowed', state: { start: now, count: 1 }, newWindow: true };
    }
    if (state.count >= rule.limit) {
        return { kind: 'limited' };
    }
    return { kind: 'allowed', state: { start: state.start, count: state.count + 1 }, newWindow: false };
}
