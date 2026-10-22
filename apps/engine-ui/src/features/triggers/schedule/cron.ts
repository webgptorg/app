/** One cron field: the values it matches, ascending, and whether it was `*` (which matters for the day fields). */
export interface CronField {
    readonly values: readonly number[];
    readonly any: boolean;
    /** The field as written, for the describer's step and range wording. */
    readonly source: string;
}

export interface Cron {
    readonly minute: CronField;
    readonly hour: CronField;
    readonly day: CronField;
    readonly month: CronField;
    /** 0 is Sunday; a written 7 reads as 0. */
    readonly weekday: CronField;
}

const ITEM = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/;

function parseField(source: string, min: number, max: number): CronField | undefined {
    const values = new Set<number>();
    for (const item of source.split(',')) {
        const match = ITEM.exec(item);
        if (match === null) return undefined;
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
    return { values: [...values].sort((a, b) => a - b), any: source === '*', source };
}

/**
 * The five-field dialect the contract names (minute, hour, day of month, month, day of week) with numbers only: `*`,
 * `n`, `a-b`, lists and `/step`, as the reference engine reads it. Anything else (names like `MON`, `L`, `W`, `?`, a
 * seconds field) is `undefined`: the form says so, the describer shows the raw expression, and the engine decides.
 * Plain parsing over a regular expression; nothing is evaluated.
 */
export function parseCron(expression: string): Cron | undefined {
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) return undefined;
    const [minute = '', hour = '', day = '', month = '', weekday = ''] = fields;
    const parsed = {
        minute: parseField(minute, 0, 59),
        hour: parseField(hour, 0, 23),
        day: parseField(day, 1, 31),
        month: parseField(month, 1, 12),
        weekday: parseField(weekday, 0, 7),
    };
    if (!parsed.minute || !parsed.hour || !parsed.day || !parsed.month || !parsed.weekday) return undefined;
    const weekdays = new Set(parsed.weekday.values.map((value) => (value === 7 ? 0 : value)));
    return {
        minute: parsed.minute,
        hour: parsed.hour,
        day: parsed.day,
        month: parsed.month,
        weekday: { ...parsed.weekday, values: [...weekdays].sort((a, b) => a - b) },
    };
}

/** Vixie cron: with both day fields restricted, a day matching either one fires. */
export function cronDayMatches(cron: Cron, day: number, weekday: number): boolean {
    if (cron.day.any) return cron.weekday.any || cron.weekday.values.includes(weekday);
    if (cron.weekday.any) return cron.day.values.includes(day);
    return cron.day.values.includes(day) || cron.weekday.values.includes(weekday);
}
