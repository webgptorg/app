import type { EngineId } from '@ptbk/protocol';

import type { Clock } from '../clock';

/** `in`: from browsers to the engine; `out`: from the engine to browsers. */
export type TrafficDirection = 'in' | 'out';

export interface DailyTraffic {
    /** UTC day, `YYYY-MM-DD`. */
    readonly day: string;
    readonly engineId: EngineId;
    readonly bytesIn: number;
    readonly bytesOut: number;
}

/**
 * Bytes relayed per engine per UTC day (spec, Metadata we still see: byte counts are aggregated per day), in memory
 * for I-04 to export. No per-connection records: no browser IP, hostname or time finer than the day.
 */
export interface TrafficCounters {
    record(engineId: EngineId, direction: TrafficDirection, bytes: number): void;
    /** Today and the previous `retainDays - 1` days, oldest first. */
    snapshot(): readonly DailyTraffic[];
}

const MS_PER_DAY = 86_400_000;

interface Totals {
    bytesIn: number;
    bytesOut: number;
}

export function createTrafficCounters(deps: { readonly clock: Clock; readonly retainDays: number }): TrafficCounters {
    const { clock, retainDays } = deps;
    if (!Number.isSafeInteger(retainDays) || retainDays < 1) throw new RangeError('retainDays must be at least 1');
    const days = new Map<number, Map<EngineId, Totals>>();

    function today(): number {
        const day = Math.floor(clock.nowMs() / MS_PER_DAY);
        for (const old of days.keys()) if (old <= day - retainDays) days.delete(old);
        return day;
    }

    return {
        record(engineId, direction, bytes) {
            const day = today();
            let engines = days.get(day);
            if (engines === undefined) {
                engines = new Map();
                days.set(day, engines);
            }
            let totals = engines.get(engineId);
            if (totals === undefined) {
                totals = { bytesIn: 0, bytesOut: 0 };
                engines.set(engineId, totals);
            }
            if (direction === 'in') totals.bytesIn += bytes;
            else totals.bytesOut += bytes;
        },
        snapshot() {
            today();
            return [...days.entries()]
                .sort(([a], [b]) => a - b)
                .flatMap(([day, engines]) =>
                    [...engines].map(([engineId, totals]) => ({
                        day: new Date(day * MS_PER_DAY).toISOString().slice(0, 10),
                        engineId,
                        ...totals,
                    })),
                );
        },
    };
}
