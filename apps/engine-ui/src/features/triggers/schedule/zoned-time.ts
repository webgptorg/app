/** A wall-clock reading in one time zone; `month` is 1-based and `weekday` 0 (Sunday) to 6. */
export interface WallTime {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
    readonly weekday: number;
}

const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Building a formatter costs far more than using one, and a preview asks for the same zone thousands of times. */
const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
    const cached = formatters.get(timeZone);
    if (cached !== undefined) return cached;
    let created: Intl.DateTimeFormat | null;
    try {
        created = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            weekday: 'short',
        });
    } catch {
        created = null;
    }
    if (formatters.size < 256) formatters.set(timeZone, created);
    return created;
}

/** Whether `Intl` knows the IANA zone; the engine still decides (422 `invalid-schedule`). */
export function isKnownTimeZone(timeZone: string): boolean {
    return timeZone !== '' && formatterFor(timeZone) !== null;
}

/** The wall clock in `timeZone` at `instant` (ms since the epoch), as `Intl` computes it; `null` for an unknown zone. */
export function wallTimeAt(instant: number, timeZone: string): WallTime | null {
    const format = formatterFor(timeZone);
    if (format === null) return null;
    const parts: Record<string, string> = {};
    for (const { type, value } of format.formatToParts(instant)) parts[type] = value;
    return {
        year: Number(parts['year']),
        month: Number(parts['month']),
        day: Number(parts['day']),
        hour: Number(parts['hour']),
        minute: Number(parts['minute']),
        weekday: WEEKDAYS[parts['weekday'] ?? ''] ?? -1,
    };
}

function asUtc(wall: Omit<WallTime, 'weekday'>): number {
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * The instant at which the wall clock in `timeZone` reads `wall`, for a date and time typed into the form. The zone's
 * offsets a day either side come from `Intl`. A time that occurs twice (clocks going back) resolves to its first
 * occurrence; a time skipped by clocks going forward reads as the clock time that far after the change, as `Date`
 * does. `null` for an unknown zone.
 */
export function instantOfWallTime(wall: Omit<WallTime, 'weekday'>, timeZone: string): number | null {
    const target = asUtc(wall);
    const offsetAt = (instant: number): number | null => {
        const seen = wallTimeAt(instant, timeZone);
        return seen === null ? null : asUtc(seen) - instant;
    };
    const before = offsetAt(target - DAY_MS);
    const after = offsetAt(target + DAY_MS);
    if (before === null || after === null) return null;
    const exact = [target - before, target - after]
        .sort((a, b) => a - b)
        .find((instant) => offsetAt(instant) === target - instant);
    return exact ?? target - before;
}
