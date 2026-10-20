import type { Recurrence, ScheduleConfig } from '../capabilities/triggers';

const MINUTE_MS = 60_000;
/** A cron that cannot fire within this horizon (say, 30 February) is refused as an invalid schedule. */
const HORIZON_MS = 5 * 366 * 24 * 3600 * 1000;

interface Cron {
    readonly minutes: ReadonlySet<number>;
    readonly hours: ReadonlySet<number>;
    readonly days: ReadonlySet<number>;
    readonly months: ReadonlySet<number>;
    readonly weekdays: ReadonlySet<number>;
    readonly anyDay: boolean;
    readonly anyWeekday: boolean;
}

/** Numeric fields only (`*`, `n`, `a-b`, lists and `/step`); names like `MON` are not accepted. */
function parseField(field: string, min: number, max: number): Set<number> | undefined {
    const values = new Set<number>();
    for (const item of field.split(',')) {
        const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
        if (!match) return undefined;
        const step = match[4] === undefined ? 1 : Number(match[4]);
        let from = min;
        let to = max;
        if (match[1] !== '*') {
            from = Number(match[2]);
            to = match[3] === undefined ? (match[4] === undefined ? from : max) : Number(match[3]);
        }
        if (step < 1 || from < min || to > max || from > to) return undefined;
        for (let value = from; value <= to; value += step) values.add(value);
    }
    return values;
}

function parseCron(expression: string): Cron | undefined {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) return undefined;
    const [minute = '', hour = '', day = '', month = '', weekday = ''] = fields;
    const minutes = parseField(minute, 0, 59);
    const hours = parseField(hour, 0, 23);
    const days = parseField(day, 1, 31);
    const months = parseField(month, 1, 12);
    const weekdays = parseField(weekday, 0, 7);
    if (!minutes || !hours || !days || !months || !weekdays) return undefined;
    // 7 is Sunday too.
    if (weekdays.delete(7)) weekdays.add(0);
    return { minutes, hours, days, months, weekdays, anyDay: day === '*', anyWeekday: weekday === '*' };
}

const WEEKDAYS: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function formatter(timeZone: string): Intl.DateTimeFormat | undefined {
    try {
        return new Intl.DateTimeFormat('en-US', {
            timeZone,
            hourCycle: 'h23',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            weekday: 'short',
        });
    } catch {
        return undefined;
    }
}

function localParts(format: Intl.DateTimeFormat, at: number) {
    const parts: Record<string, string> = {};
    for (const { type, value } of format.formatToParts(at)) parts[type] = value;
    return {
        month: Number(parts['month']),
        day: Number(parts['day']),
        hour: Number(parts['hour']),
        minute: Number(parts['minute']),
        weekday: WEEKDAYS[parts['weekday'] ?? ''] ?? -1,
    };
}

/** Vixie cron semantics: with both day fields restricted, either may match. */
function dayMatches(cron: Cron, day: number, weekday: number): boolean {
    if (cron.anyDay) return cron.anyWeekday || cron.weekdays.has(weekday);
    if (cron.anyWeekday) return cron.days.has(day);
    return cron.days.has(day) || cron.weekdays.has(weekday);
}

/** The first minute at or after `from` that matches, skipping whole days and hours that cannot. */
function nextCronFire(cron: Cron, format: Intl.DateTimeFormat, from: number): number | null {
    let at = Math.ceil(from / MINUTE_MS) * MINUTE_MS;
    while (at - from <= HORIZON_MS) {
        const local = localParts(format, at);
        if (!cron.months.has(local.month) || !dayMatches(cron, local.day, local.weekday)) {
            at += (24 * 60 - (local.hour * 60 + local.minute)) * MINUTE_MS;
        } else if (!cron.hours.has(local.hour)) {
            at += (60 - local.minute) * MINUTE_MS;
        } else if (!cron.minutes.has(local.minute)) {
            at += MINUTE_MS;
        } else {
            return at;
        }
    }
    return null;
}

/** Why the engine refuses a schedule (422 `invalid-schedule`), or `undefined` when it can run it. */
export function scheduleProblem(
    recurrence: Recurrence,
    startsAt: string,
    endsAt: string | null,
    now: string,
): string | undefined {
    if (endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) return 'endsAt must be after startsAt.';
    switch (recurrence.kind) {
        case 'once':
            if (Date.parse(recurrence.at) < Date.parse(now)) return 'The time is in the past.';
            if (Date.parse(recurrence.at) < Date.parse(startsAt)) return 'The time is before startsAt.';
            if (endsAt !== null && Date.parse(recurrence.at) >= Date.parse(endsAt)) return 'The time is after endsAt.';
            return undefined;
        case 'interval':
            return undefined;
        case 'cron': {
            const cron = parseCron(recurrence.expression);
            if (!cron) return 'Not a five-field cron expression.';
            const format = formatter(recurrence.timeZone);
            if (!format) return 'Unknown time zone.';
            if (nextCronFire(cron, format, Math.max(Date.parse(now), Date.parse(startsAt))) === null) {
                return 'The expression never fires.';
            }
            return undefined;
        }
    }
}

/** When a schedule fires next, or `null` when it never will again. */
export function nextFireAt(config: ScheduleConfig, now: string, lastFiredAt: string | null): string | null {
    if (config.maxRunCount !== null && config.runCount >= config.maxRunCount) return null;
    const earliest = Math.max(
        Date.parse(now),
        Date.parse(config.startsAt),
        lastFiredAt === null ? 0 : Date.parse(lastFiredAt) + 1,
    );
    let next: number | null;
    const recurrence = config.recurrence;
    switch (recurrence.kind) {
        case 'once':
            next = config.runCount === 0 ? Date.parse(recurrence.at) : null;
            break;
        case 'interval': {
            const every = recurrence.everySeconds * 1000;
            const anchor = Date.parse(config.startsAt);
            next = anchor + Math.max(0, Math.ceil((earliest - anchor) / every)) * every;
            break;
        }
        case 'cron': {
            const cron = parseCron(recurrence.expression);
            const format = formatter(recurrence.timeZone);
            next = cron && format ? nextCronFire(cron, format, earliest) : null;
            break;
        }
    }
    if (next === null || (config.endsAt !== null && next >= Date.parse(config.endsAt))) return null;
    return new Date(next).toISOString();
}
