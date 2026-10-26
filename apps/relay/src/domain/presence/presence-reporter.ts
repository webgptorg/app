import type { EngineId } from '@ptbk/protocol';

import type { Clock } from '../clock';
import type { Logger } from '../logger';

/** A full report at least this often, so a lost one heals and the dashboard's 3-minute expiry never hits a live relay. */
export const PRESENCE_INTERVAL_MS = 60_000;
/** A tunnel that becomes ready or closes reaches the dashboard within this, however much other tunnels churn. */
export const PRESENCE_DEBOUNCE_MS = 5_000;
/** The dashboard's cap per report (R-07); a longer list would be refused whole, so the relay sends this many. */
export const MAX_PRESENCE_ENGINE_IDS = 10_000;

export type PresenceOutcome =
    | { readonly kind: 'accepted' }
    /** The HTTP status, or why there was none. */
    | { readonly kind: 'failed'; readonly status: number | 'timeout' | 'network' };

/** Where presence goes: the dashboard's `PUT /internal/v1/relays/presence`. Never rejects. */
export interface PresenceSink {
    report(engineIds: readonly EngineId[], signal: AbortSignal): Promise<PresenceOutcome>;
}

export interface PresenceReporterOptions {
    readonly clock: Clock;
    readonly sink: PresenceSink;
    readonly logger: Logger;
    /** The engines with a ready tunnel right now. */
    readonly engineIds: () => readonly EngineId[];
}

export interface PresenceReporter {
    /** The first report follows one debounce later, so a restarted relay clears what it reported before. */
    start(): void;
    /** A tunnel became ready or closed. */
    changed(): void;
    /** Cancels pending reports and aborts the one in flight. */
    stop(): void;
}

/**
 * Tells the dashboard which engines hold a ready tunnel here: the full list each time, never deltas, every
 * {@link PRESENCE_INTERVAL_MS} and within {@link PRESENCE_DEBOUNCE_MS} of a change. The first change opens the window
 * and later ones join it, so churn cannot postpone a report; at most about 13 reports a minute. A failed report is
 * logged and replaced by the next one; nothing here touches tunnels.
 */
export function createPresenceReporter(options: PresenceReporterOptions): PresenceReporter {
    const { clock, sink, logger, engineIds } = options;
    let running = false;
    let controller = new AbortController();
    let cancelDebounce: (() => void) | null = null;
    let cancelPeriodic: (() => void) | null = null;
    let inFlight = false;
    let changedInFlight = false;
    // Bumped by stop, so a report still in flight from before cannot schedule a second chain after a restart.
    let generation = 0;

    function cancelTimers(): void {
        cancelDebounce?.();
        cancelDebounce = null;
        cancelPeriodic?.();
        cancelPeriodic = null;
    }

    function current(): readonly EngineId[] {
        const all = [...new Set(engineIds())].sort();
        if (all.length <= MAX_PRESENCE_ENGINE_IDS) return all;
        logger.warn('presence.truncated', { engines: all.length, cap: MAX_PRESENCE_ENGINE_IDS });
        return all.slice(0, MAX_PRESENCE_ENGINE_IDS);
    }

    function settle(round: number, outcome: PresenceOutcome): void {
        if (round !== generation) return;
        inFlight = false;
        if (outcome.kind === 'failed') logger.warn('presence.report-failed', { status: outcome.status });
        cancelPeriodic = clock.setTimeout(send, PRESENCE_INTERVAL_MS);
        if (changedInFlight) {
            changedInFlight = false;
            changed();
        }
    }

    function send(): void {
        cancelTimers();
        inFlight = true;
        const round = generation;
        sink.report(current(), controller.signal).then(
            (outcome) => {
                settle(round, outcome);
            },
            () => {
                settle(round, { kind: 'failed', status: 'network' });
            },
        );
    }

    function changed(): void {
        if (!running) return;
        if (inFlight) {
            changedInFlight = true;
            return;
        }
        cancelDebounce ??= clock.setTimeout(send, PRESENCE_DEBOUNCE_MS);
    }

    return {
        start() {
            if (running) return;
            running = true;
            inFlight = false;
            changedInFlight = false;
            controller = new AbortController();
            changed();
        },
        changed,
        stop() {
            if (!running) return;
            running = false;
            generation++;
            cancelTimers();
            controller.abort(new DOMException('relay stopping', 'AbortError'));
        },
    };
}
