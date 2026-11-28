import { METERS } from '../../shared/metering';
import type { Logger } from '../ports/logger';
import { ROLLUP_RETENTION_MONTHS } from '../usage/usage-rollup-job';
import { monthsBefore, utcDay, type UsageDay } from '../usage/usage-day';
import { measureAll } from './meters';
import type { MeterDayRow, MeteringStore } from './metering-store';
import type { OrgUsageFacts } from './usage-facts';

export function meterDayRows(day: UsageDay, facts: OrgUsageFacts): MeterDayRow[] {
    const readings = measureAll(facts);
    const { orgId } = facts;
    return METERS.flatMap((meter) => {
        const reading = readings[meter];
        return [
            { day, orgId, scope: 'org', scopeId: orgId, meter, ...reading.org },
            ...reading.teams.map(({ teamId, ...count }) => ({
                day,
                orgId,
                scope: 'team' as const,
                scopeId: teamId,
                meter,
                ...count,
            })),
            ...reading.projects.map(({ engineId, ...count }) => ({
                day,
                orgId,
                scope: 'project' as const,
                scopeId: engineId,
                meter,
                ...count,
            })),
        ];
    });
}

export interface MeterHistoryDeps {
    readonly store: Pick<MeteringStore, 'readMeteredFacts' | 'upsertMeterDays' | 'pruneMeterDays'>;
    readonly logger: Logger;
}

/**
 * Every 15 minutes, beside the usage rollup: today's reading of every meter for every metered organization, then the
 * rollups' retention. It reads the engine days the rollup wrote, so its engine counts trail by at most one run.
 */
export async function runMeterHistory(
    deps: MeterHistoryDeps,
    scheduledTime: number,
    signal: AbortSignal,
): Promise<void> {
    const day = utcDay(scheduledTime);
    const orgs = await deps.store.readMeteredFacts();
    signal.throwIfAborted();
    const rows = orgs.flatMap((facts) => meterDayRows(day, facts));
    await deps.store.upsertMeterDays(rows);
    await deps.store.pruneMeterDays(utcDay(monthsBefore(scheduledTime, ROLLUP_RETENTION_MONTHS)));
    deps.logger.info('metering.history-written', { orgs: orgs.length, rows: rows.length });
}
