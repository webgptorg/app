import { mapConcurrently } from '../engines/map-concurrently';
import type { Logger } from '../ports/logger';
import type { EngineStatusDirectory } from '../status/engine-status-directory';
import type { EngineDay } from './engine-activity';
import { monthsBefore, previousDay, utcDay } from './usage-day';
import type { ActiveEngine, UsageStore } from './usage-store';

/** Raw events are kept 13 months, so a year can be compared with the one before; rollups 25 months (ADR 0022). */
export const EVENT_RETENTION_MONTHS = 13;
export const ROLLUP_RETENTION_MONTHS = 25;

export interface UsageRollupDeps {
    readonly store: UsageStore;
    readonly engineStatus: Pick<EngineStatusDirectory, 'getActivity'>;
    /** Status objects asked at once. */
    readonly concurrency: number;
    readonly logger: Logger;
}

/**
 * Every 15 minutes: today's and yesterday's rows for every engine and person, then the retention prune. Each row is
 * rewritten whole, so a repeated or overlapping run changes nothing, and the first run after midnight completes the
 * day before. An engine whose object fails to answer only misses this run.
 */
export async function runUsageRollup(deps: UsageRollupDeps, scheduledTime: number, signal: AbortSignal): Promise<void> {
    const today = utcDay(scheduledTime);
    const days = new Set([today, previousDay(today)]);
    const engines = await deps.store.listActiveEngines();
    let unanswered = 0;
    const answered = await mapConcurrently(engines, deps.concurrency, async (engine) => {
        if (signal.aborted) {
            unanswered++;
            return [];
        }
        try {
            const activity = await deps.engineStatus.getActivity(engine.engineId);
            return [activity?.current, activity?.previous].flatMap((day) =>
                day != null && days.has(day.day) ? [{ ...day, ...engine }] : [],
            );
        } catch {
            unanswered++;
            return [];
        }
    });
    const rows: (EngineDay & ActiveEngine)[] = answered.flat();
    signal.throwIfAborted();
    await deps.store.upsertEngineDays(rows);
    for (const day of days) {
        await deps.store.rollUpPeople(day);
    }
    await deps.store.prune({
        eventsBefore: monthsBefore(scheduledTime, EVENT_RETENTION_MONTHS),
        daysBefore: utcDay(monthsBefore(scheduledTime, ROLLUP_RETENTION_MONTHS)),
    });
    deps.logger.info('usage.rolled-up', { engines: engines.length, engineDays: rows.length, unanswered });
}
