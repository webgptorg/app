import { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A UTC calendar day as `YYYY-MM-DD`: what the daily rollups are keyed by, and sorts as it reads. */
export const usageDaySchema = z.iso.date().brand<'UsageDay'>();
export type UsageDay = z.infer<typeof usageDaySchema>;

export function utcDay(ms: number): UsageDay {
    return usageDaySchema.parse(new Date(ms).toISOString().slice(0, 10));
}

/** Midnight UTC that starts `day`, in milliseconds. */
export function dayStartMs(day: UsageDay): number {
    return Date.parse(`${day}T00:00:00.000Z`);
}

export function previousDay(day: UsageDay): UsageDay {
    return utcDay(dayStartMs(day) - DAY_MS);
}

export function nextDay(day: UsageDay): UsageDay {
    return utcDay(dayStartMs(day) + DAY_MS);
}

/** The same moment `months` calendar months earlier; a day past the month's end rolls over (31 March less one: 3 March). */
export function monthsBefore(ms: number, months: number): number {
    const date = new Date(ms);
    date.setUTCMonth(date.getUTCMonth() - months);
    return date.getTime();
}
