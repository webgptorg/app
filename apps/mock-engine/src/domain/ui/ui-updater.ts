import type { Clock } from '../clock';
import type { Logger } from '../logger';
import type { UiUpdateOutcome } from './ui-update';

export const DEFAULT_UI_CHECK_INTERVAL_S = 3600;

export interface UiUpdaterDeps {
    /** One update check; the updater never runs two at once. */
    readonly check: (signal: AbortSignal) => Promise<UiUpdateOutcome>;
    readonly clock: Clock;
    readonly logger: Logger;
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
 * When the UI loader checks: at startup, every `intervalMs` and on demand, one check at a time. An exception from a
 * check (a broken disk, a bug) is logged by name and fails closed: the active bundle keeps being served.
 */
export function createUiUpdater(deps: UiUpdaterDeps): UiUpdater {
    const controller = new AbortController();
    let queue: Promise<unknown> = Promise.resolve();
    let last: UiUpdateOutcome | null = null;
    let cancelTimer: (() => void) | null = null;
    let stopped = false;

    async function run(): Promise<UiUpdateOutcome> {
        try {
            last = await deps.check(controller.signal);
        } catch (error) {
            if (!controller.signal.aborted) {
                deps.logger.error('ui.check-failed', { problem: error instanceof Error ? error.name : 'unknown' });
            }
            last = { kind: 'unavailable' };
        }
        return last;
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
            controller.abort(new Error('ui updater stopped'));
            await queue;
        },
    };
}
