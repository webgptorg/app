import type { Clock } from '../clock';

/** Named per-client-IP policies; every route names one, session routes included (AGENTS.md rule 6). */
export const RATE_LIMITS = {
    /** Pages, JSON, SSE and the echo socket. */
    'spike-ip': { limit: 600, windowMs: 60_000 },
    /** Download and screencast, which send far more than they receive. */
    'spike-bulk-ip': { limit: 60, windowMs: 60_000 },
    /** The engine API: a busy UI makes a few requests a second per member, plus streams. */
    'engine-api-ip': { limit: 1_200, windowMs: 60_000 },
    /** Draft test replies (`test-chat@1`): each one is a model call, and a person types far slower than this. */
    'engine-api-test-chat-ip': { limit: 60, windowMs: 60_000 },
    /** Live channel attaches (`browser-tab@1`): one per opened session, plus reconnects after a dropped network. */
    'live-channel-ip': { limit: 120, windowMs: 60_000 },
    /**
     * Voice clips and spoken replies (`voice-input@1`, `voice-output@1`): each is a provider call, and a person records
     * or listens to a few a minute; a conformance run sends a few dozen.
     */
    'engine-api-voice-ip': { limit: 60, windowMs: 60_000 },
    /** AI tool checks and sign-in answers (`ai-tools@1`): each is a model or provider call; a person clicks a few. */
    'engine-api-ai-tools-ip': { limit: 30, windowMs: 60_000 },
    /** UI bundle files: a cold page load fetches a few dozen, cached ones none. */
    'ui-ip': { limit: 1_200, windowMs: 60_000 },
    /** Gateway pages and forms: sign-in, sign-out, step-up. */
    'gateway-ip': { limit: 60, windowMs: 60_000 },
    /** The setup secret's endpoints: a 128-bit secret cannot be guessed anyway, but nobody gets to try at speed. */
    'setup-ip': { limit: 10, windowMs: 60_000 },
    /** The dev-only control listener, driven by test suites. */
    control: { limit: 6_000, windowMs: 60_000 },
} as const satisfies Readonly<Record<string, { readonly limit: number; readonly windowMs: number }>>;

export type RateLimitRule = keyof typeof RATE_LIMITS;

export function isRateLimitRule(name: string): name is RateLimitRule {
    return Object.hasOwn(RATE_LIMITS, name);
}

export type RateLimitDecision =
    { readonly kind: 'allowed' } | { readonly kind: 'limited'; readonly retryAfterMs: number };

export interface RateLimiter {
    consume(rule: RateLimitRule, key: string): RateLimitDecision;
}

/** The in-memory limiter; the control listener's reset clears it, so one test's traffic never limits the next. */
export interface WindowRateLimiter extends RateLimiter {
    clear(): void;
}

/** Above this many live windows, new keys are refused until old windows expire, so memory stays bounded. */
export const MAX_RATE_LIMIT_KEYS = 10_000;

interface Window {
    readonly startMs: number;
    readonly windowMs: number;
    count: number;
}

/** Fixed windows in memory: one engine process, no shared store needed. */
export function createWindowRateLimiter(deps: { readonly clock: Clock; readonly maxKeys?: number }): WindowRateLimiter {
    const maxKeys = deps.maxKeys ?? MAX_RATE_LIMIT_KEYS;
    const windows = new Map<string, Window>();

    function sweep(nowMs: number): void {
        for (const [key, window] of windows) {
            if (nowMs >= window.startMs + window.windowMs) windows.delete(key);
        }
    }

    return {
        consume(rule, key) {
            const { limit, windowMs } = RATE_LIMITS[rule];
            const nowMs = deps.clock.nowMs();
            const id = `${rule}\0${key}`;
            let window = windows.get(id);
            if (window !== undefined && nowMs >= window.startMs + window.windowMs) {
                windows.delete(id);
                window = undefined;
            }
            if (window === undefined) {
                if (windows.size >= maxKeys) sweep(nowMs);
                if (windows.size >= maxKeys) return { kind: 'limited', retryAfterMs: windowMs };
                window = { startMs: nowMs, windowMs, count: 0 };
                windows.set(id, window);
            }
            if (window.count >= limit) return { kind: 'limited', retryAfterMs: window.startMs + windowMs - nowMs };
            window.count++;
            return { kind: 'allowed' };
        },
        clear() {
            windows.clear();
        },
    };
}
