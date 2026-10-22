import type { Cron } from './cron';
import { cronDayMatches, parseCron } from './cron';
import { wallTimeAt } from './zoned-time';

const MINUTE_MS = 60_000;
/** A cron that cannot fire within this horizon (say, 30 February) previews nothing, as the engine would refuse it. */
const HORIZON_MS = 5 * 366 * 24 * 3600 * 1000;

export type PreviewRecurrence =
    | { readonly kind: 'once'; readonly at: number }
    | { readonly kind: 'interval'; readonly everySeconds: number }
    | { readonly kind: 'cron'; readonly expression: string; readonly timeZone: string };

/** What decides when a schedule fires, with instants as milliseconds since the epoch. */
export interface PreviewSchedule {
    readonly recurrence: PreviewRecurrence;
    readonly startsAt: number;
    readonly endsAt: number | null;
    readonly maxRunCount: number | null;
    readonly runCount: number;
}

/**
 * The first minute at or after `from` whose wall clock in `timeZone` matches, skipping whole days and hours that cannot.
 * Every reading comes from `Intl`, so DST is the zone's own: a time the clocks skip never matches, a time they repeat
 * matches at both instants, which is what the reference engine does.
 */
function nextCronFire(cron: Cron, timeZone: string, from: number): number | null {
    let at = Math.ceil(from / MINUTE_MS) * MINUTE_MS;
    while (at - from <= HORIZON_MS) {
        const local = wallTimeAt(at, timeZone);
        if (local === null) return null;
        if (!cron.month.values.includes(local.month) || !cronDayMatches(cron, local.day, local.weekday)) {
            const skip = (24 * 60 - (local.hour * 60 + local.minute)) * MINUTE_MS;
            const landed = wallTimeAt(at + skip, timeZone);
            // A day the clocks spring forward is an hour short, so the skip overshoots the next midnight.
            const overshoot = landed !== null && landed.day !== local.day ? landed.hour * 60 + landed.minute : 0;
            at += skip - overshoot * MINUTE_MS;
        } else if (!cron.hour.values.includes(local.hour)) {
            at += (60 - local.minute) * MINUTE_MS;
        } else if (!cron.minute.values.includes(local.minute)) {
            const nextMinute = cron.minute.values.find((minute) => minute > local.minute) ?? 60;
            at += (nextMinute - local.minute) * MINUTE_MS;
        } else {
            return at;
        }
    }
    return null;
}

/**
 * Up to `count` fire times from `from` on, as an estimate for the form: the engine's scheduler is authoritative (its
 * `nextFireAt`, and its 422 for a schedule it cannot run). Mirrors the contract's rules: nothing before `startsAt`,
 * nothing at or after `endsAt`, no more than `maxRunCount` runs in all, and an interval anchored at `startsAt`.
 */
export function previewFires(schedule: PreviewSchedule, from: number, count: number): number[] {
    const fires: number[] = [];
    const remaining = schedule.maxRunCount === null ? count : Math.min(count, schedule.maxRunCount - schedule.runCount);
    const inRange = (at: number) => schedule.endsAt === null || at < schedule.endsAt;
    let earliest = Math.max(from, schedule.startsAt);
    const recurrence = schedule.recurrence;
    switch (recurrence.kind) {
        case 'once':
            if (schedule.runCount === 0 && remaining > 0 && recurrence.at >= earliest && inRange(recurrence.at)) {
                fires.push(recurrence.at);
            }
            return fires;
        case 'interval': {
            const every = recurrence.everySeconds * 1000;
            let at = schedule.startsAt + Math.max(0, Math.ceil((earliest - schedule.startsAt) / every)) * every;
            while (fires.length < remaining && inRange(at)) {
                fires.push(at);
                at += every;
            }
            return fires;
        }
        case 'cron': {
            const cron = parseCron(recurrence.expression);
            if (cron === undefined) return fires;
            while (fires.length < remaining) {
                const at = nextCronFire(cron, recurrence.timeZone, earliest);
                if (at === null || !inRange(at)) break;
                fires.push(at);
                earliest = at + 1;
            }
            return fires;
        }
    }
}
