import type { Clock } from '../clock';
import type { Random } from '../random';
import { randomUpTo } from '../tunnel/backoff';
import type { RegisterEngineDeps, RegistrationOutcome, UnavailableReason } from './register';
import { registerEngine } from './register';

/**
 * How long one `connect` keeps retrying an unreachable dashboard before it hands back to the operator. A link code
 * lives far longer (30 days), so giving up loses nothing: the same code works when they run `connect` again.
 */
export const REGISTRATION_RETRY_WINDOW_MS = 30 * 60_000;
/** With equal jitter the first wait is 5 to 10 s: at least the 5 s identity-and-registration.md asks for. */
export const REGISTRATION_RETRY_BASE_MS = 10_000;
/** The dashboard counts attempts per minute; two minutes between tries leaves its window room to clear. */
export const REGISTRATION_RETRY_CAP_MS = 120_000;

/** One wait before the next attempt, for the terminal and the log stream. */
export interface RegistrationRetry {
    readonly reason: UnavailableReason;
    /** Counts the failed attempts so far, from 1. */
    readonly attempt: number;
    readonly delayMs: number;
}

export interface RegisterWithRetryDeps extends RegisterEngineDeps {
    readonly clock: Clock;
    readonly random: Random;
    /** Called before each wait. */
    readonly onRetry?: (retry: RegistrationRetry) => void;
}

/**
 * Equal jitter: at least half of `base · 2^attempt` (capped), so the operator is told a time that is close to true,
 * and spread over the other half so engines behind one outage do not come back in step.
 */
export function registrationRetryDelayMs(attempt: number, random: Random): number {
    const ceiling = Math.min(REGISTRATION_RETRY_CAP_MS, REGISTRATION_RETRY_BASE_MS * 2 ** Math.min(attempt, 30));
    const half = Math.floor(ceiling / 2);
    return half + randomUpTo(random, ceiling - half);
}

function wait(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(signal.reason as Error);
            return;
        }
        const onAbort = (): void => {
            cancel();
            reject(signal.reason as Error);
        };
        const cancel = clock.setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Registers, retrying `unavailable` answers (no answer, a 5xx, `rate-limited`, a code this build does not know) with
 * backoff for {@link REGISTRATION_RETRY_WINDOW_MS} from the first attempt. Rejections and refused answers end at once.
 */
export async function registerWithRetry(deps: RegisterWithRetryDeps): Promise<RegistrationOutcome> {
    const deadlineMs = deps.clock.nowMs() + REGISTRATION_RETRY_WINDOW_MS;
    for (let attempt = 0; ; attempt++) {
        const outcome = await registerEngine(deps);
        if (outcome.kind !== 'unavailable') return outcome;
        const delayMs = registrationRetryDelayMs(attempt, deps.random);
        if (deps.clock.nowMs() + delayMs >= deadlineMs) return outcome;
        const retry = { reason: outcome.reason, attempt: attempt + 1, delayMs };
        deps.logger.warn('registration.retrying', retry);
        deps.onRetry?.(retry);
        await wait(deps.clock, delayMs, deps.signal);
    }
}
