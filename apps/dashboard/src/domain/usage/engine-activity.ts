import { CpuLoad, EngineVersion, SetupState, UpdateState, type AnyHeartbeat } from '@ptbk/protocol';
import { z } from 'zod';

import { usageDaySchema, utcDay } from './usage-day';

const count = z.int().min(0);

/** One engine's UTC day: its accepted heartbeats, and the last one's numbers and closed enums. */
export const engineDaySchema = z.strictObject({
    day: usageDaySchema,
    beats: count,
    firstBeatAt: count,
    lastBeatAt: count,
    engineVersion: EngineVersion,
    agents: count,
    members: count,
    setup: SetupState.nullable(),
    updateState: UpdateState,
    cpuLoad: CpuLoad,
});
export type EngineDay = z.infer<typeof engineDaySchema>;

/**
 * What an engine's status object counts for the daily rollup, in the status it already saves on every heartbeat, so
 * counting costs no write of its own. The day before is kept until the next day starts, for the rollup's last pass.
 */
export const engineActivitySchema = z.strictObject({
    current: engineDaySchema,
    previous: engineDaySchema.nullable(),
});
export type EngineActivity = z.infer<typeof engineActivitySchema>;

export function countHeartbeat(
    activity: EngineActivity | undefined,
    heartbeat: AnyHeartbeat,
    receivedAt: number,
): EngineActivity {
    const day = utcDay(receivedAt);
    const last = {
        lastBeatAt: receivedAt,
        engineVersion: heartbeat.version,
        agents: heartbeat.agents,
        members: heartbeat.members,
        setup: heartbeat.setup ?? null,
        updateState: heartbeat.update,
        cpuLoad: heartbeat.cpuLoad,
    };
    if (activity?.current.day === day) {
        return {
            current: { ...activity.current, ...last, beats: activity.current.beats + 1 },
            previous: activity.previous,
        };
    }
    return { current: { day, beats: 1, firstBeatAt: receivedAt, ...last }, previous: activity?.current ?? null };
}
