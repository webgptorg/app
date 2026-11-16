import type { Clock } from '../clock';
import type { Logger } from '../logger';
import type { Random } from '../random';
import { randomUpTo } from '../tunnel/backoff';
import type { UiUpdateOutcome } from './ui-update';

export const DEFAULT_UI_CHECK_INTERVAL_S = 3600;
/** Spreads the extra check at `eligibleAt` so engines that saw a release together do not hit the mirror together. */
export const ELIGIBLE_RECHECK_JITTER_MS = 5000;

export interface UiUpdaterDeps {
    /** One update check; the updater never runs two at once. */
    readonly check: (signal: AbortSignal) => Promise<UiUpdateOutcome>;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly random: Random;
    readonly intervalMs: number;
    /** False under `manual`: nothing installs until the owner asks (`checkNow`). */
    readonly automatic: boolean;
}

export interface UiUpdater {
    /** With `automatic`, checks now and then every interval. */
    start(): void;
    /** Runs a check after any check in flight, and returns its outcome (a broken check is `unavailable`). */
    checkNow(): Promise<UiUpdateOutcome>;
    lastOutcome(): UiUpdateOutcome | null;
    /** Cancels the timer and aborts a check in flight; the active bundle stays. */
    stop(): Promise<void>;
}

/**
 * When the UI loader checks: at startup, every `intervalMs` and on demand, one check at a time. With `automatic`, a
 * `delay-not-elapsed` refusal also schedules one extra check at its `eligibleAt` plus jitter, so a release installs
 * when it becomes eligible rather than up to an interval later; every check replaces that pending one. An exception
 * from a check (a broken disk, a bug) is logged by name and fails closed: the active bundle keeps being served.
 */
export function createUiUpdater(deps: UiUpdaterDeps): UiUpdater {
    const controller = new AbortController();
    let queue: Promise<unknown> = Promise.resolve();
    let last: UiUpdateOutcome | null = null;
    let cancelTimer: (() => void) | null = null;
    let cancelRecheck: (() => void) | null = null;
    let stopped = false;
    // A function, not a property read: TypeScript would keep a narrowed `aborted` across the awaits below.
    const aborted = (): boolean => controller.signal.aborted;

    async function run(): Promise<UiUpdateOutcome> {
        if (aborted()) return { kind: 'unavailable' };
        try {
            last = await deps.check(controller.signal);
        } catch (error) {
            if (!aborted()) {
                deps.logger.error('ui.check-failed', { problem: error instanceof Error ? error.name : 'unknown' });
            }
            last = { kind: 'unavailable' };
        }
        scheduleRecheck(last);
        return last;
    }

    function scheduleRecheck(outcome: UiUpdateOutcome): void {
        cancelRecheck?.();
        cancelRecheck = null;
        if (!deps.automatic || stopped || outcome.kind !== 'refused' || outcome.reason !== 'delay-not-elapsed') return;
        const untilEligibleMs = (outcome.eligibleAt?.getTime() ?? 0) - deps.clock.nowMs();
        // A release already eligible yet still refused is a bug or a skewed clock; rechecking at once would spin.
        if (untilEligibleMs <= 0) return;
        const delayMs = untilEligibleMs + randomUpTo(deps.random, ELIGIBLE_RECHECK_JITTER_MS);
        cancelRecheck = deps.clock.setTimeout(() => {
            cancelRecheck = null;
            void enqueue();
        }, delayMs);
    }

    function enqueue(): Promise<UiUpdateOutcome> {
        const next = queue.then(run);
        queue = next.catch(() => undefined);
        return next;
    }

    function schedule(): void {
        if (stopped) return;
        cancelTimer = deps.clock.setTimeout(() => {
            void enqueue().finally(schedule);
        }, deps.intervalMs);
    }

    return {
        start() {
            if (!deps.automatic) return;
            void enqueue().finally(schedule);
        },
        checkNow: enqueue,
        lastOutcome: () => last,
        async stop() {
            stopped = true;
            cancelTimer?.();
            cancelRecheck?.();
            controller.abort(new Error('ui updater stopped'));
            await queue;
        },
    };
}
