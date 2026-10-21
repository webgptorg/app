import { z } from 'zod';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function dateParts(value: string): readonly [number, number, number] | undefined {
    const match = DATE_PATTERN.exec(value);
    if (match === null) return undefined;
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const date = new Date(Date.UTC(year, month - 1, day));
    // `2026-02-30` would otherwise roll over into March.
    return date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? [year, month, day] : undefined;
}

/** A calendar day as a date input writes it, `YYYY-MM-DD`. */
export const CalendarDay = z.string().refine((value) => dateParts(value) !== undefined);

/** Local midnight at the start of `date`, `days` later, as the UTC instant an engine filters by. */
export function localDayStart(date: string, days: number): string | undefined {
    const parts = dateParts(date);
    if (parts === undefined) return undefined;
    const [year, month, day] = parts;
    return new Date(year, month - 1, day + days).toISOString();
}

/**
 * An engine's `from` (inclusive) and `to` (exclusive) for the local days a reader picked: `from` is the start of the
 * first day and `to` the start of the day after the last, so both days are included whole.
 */
export function dayRange(from: string | undefined, to: string | undefined): { from?: string; to?: string } {
    const start = from === undefined ? undefined : localDayStart(from, 0);
    const end = to === undefined ? undefined : localDayStart(to, 1);
    return { ...(start === undefined ? {} : { from: start }), ...(end === undefined ? {} : { to: end }) };
}
