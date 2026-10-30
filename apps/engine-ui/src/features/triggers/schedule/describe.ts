import { m } from '../../../paraglide/messages';
import type { Locale } from '../../../paraglide/runtime';
import type { Cron, CronField } from './cron';
import { parseCron } from './cron';

/** A recurrence as the describer reads it; an unknown kind from a newer engine has only its raw name. */
export type DescribedRecurrence =
    | { readonly kind: 'once'; readonly at: string }
    | { readonly kind: 'interval'; readonly everySeconds: number }
    | { readonly kind: 'cron'; readonly expression: string; readonly timeZone: string }
    | { readonly kind: 'unknown'; readonly rawKind: string };

const WEEKDAYS = [1, 2, 3, 4, 5] as const;

const pad = (value: number) => String(value).padStart(2, '0');

function single(field: CronField): number | undefined {
    return field.values.length === 1 ? field.values[0] : undefined;
}

/** `*` or `*` with a step (`*\/15`), as the step; `undefined` for anything else. */
function everyStep(field: CronField): number | undefined {
    if (field.source === '*') return 1;
    const match = /^\*\/(\d+)$/.exec(field.source);
    return match === null ? undefined : Number(match[1]);
}

/** Every day of every month, with no weekday restriction. */
function everyDay(cron: Cron): boolean {
    return cron.day.any && cron.month.any && cron.weekday.any;
}

/** "Monday", "pondělí": a reference Monday in UTC, formatted by `Intl` in the reader's language. */
export function weekdayName(weekday: number, locale: Locale): string {
    return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 7 + weekday));
}

function monthDay(month: number, day: number, locale: Locale): string {
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
        Date.UTC(2024, month - 1, day),
    );
}

function intervalText(everySeconds: number, locale: Locale): string {
    const options = { locale };
    if (everySeconds % 86_400 === 0) return m.trigger_every_days({ count: everySeconds / 86_400 }, options);
    if (everySeconds % 3_600 === 0) return m.trigger_every_hours({ count: everySeconds / 3_600 }, options);
    if (everySeconds % 60 === 0) return m.trigger_every_minutes({ count: everySeconds / 60 }, options);
    return m.trigger_every_seconds({ count: everySeconds }, options);
}

/** The cron shapes people write by hand, in words; `undefined` for any other, which then shows as written. */
function cronText(cron: Cron, locale: Locale): string | undefined {
    const options = { locale };
    const minute = single(cron.minute);
    const hour = single(cron.hour);
    if (everyDay(cron)) {
        const minuteStep = everyStep(cron.minute);
        if (minuteStep !== undefined && cron.hour.any) return m.trigger_every_minutes({ count: minuteStep }, options);
        const hourStep = everyStep(cron.hour);
        if (minute === 0 && hourStep !== undefined) return m.trigger_every_hours({ count: hourStep }, options);
        if (minute !== undefined && cron.hour.any) return m.trigger_cron_hourly({ minute: String(minute) }, options);
    }
    if (minute === undefined || hour === undefined) return undefined;
    const time = `${pad(hour)}:${pad(minute)}`;
    if (everyDay(cron)) return m.trigger_cron_daily({ time }, options);
    if (cron.day.any && cron.month.any) {
        const days = cron.weekday.values;
        if (days.length === WEEKDAYS.length && WEEKDAYS.every((day, index) => days[index] === day)) {
            return m.trigger_cron_weekdays({ time }, options);
        }
        // Monday first, as both languages write a week.
        const ordered = [...days.filter((day) => day !== 0), ...days.filter((day) => day === 0)];
        const list = new Intl.ListFormat(locale, { type: 'conjunction' }).format(
            ordered.map((day) => weekdayName(day, locale)),
        );
        return m.trigger_cron_on_weekdays({ days: list, time }, options);
    }
    const day = single(cron.day);
    if (day === undefined || !cron.weekday.any) return undefined;
    if (cron.month.any) return m.trigger_cron_monthly({ day: String(day), time }, options);
    const month = single(cron.month);
    if (month === undefined) return undefined;
    return m.trigger_cron_yearly({ date: monthDay(month, day, locale), time }, options);
}

export interface DescribeOptions {
    readonly locale: Locale;
    /** The zone a one-off time is shown in: the reader's. */
    readonly displayTimeZone: string;
}

/**
 * A recurrence in words ("Every weekday at 08:00, Europe/Prague"). Cron in a shape the describer does not know, or
 * syntax it cannot read, falls back to the expression as written; an unknown kind shows its raw name.
 */
export function describeRecurrence(recurrence: DescribedRecurrence, options: DescribeOptions): string {
    const { locale } = options;
    switch (recurrence.kind) {
        case 'once': {
            const when = new Intl.DateTimeFormat(locale, {
                timeZone: options.displayTimeZone,
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
            }).format(new Date(recurrence.at));
            return m.trigger_once({ when }, { locale });
        }
        case 'interval':
            return intervalText(recurrence.everySeconds, locale);
        case 'cron': {
            const cron = parseCron(recurrence.expression);
            const text = cron === undefined ? undefined : cronText(cron, locale);
            return m.trigger_in_zone(
                { schedule: text ?? recurrence.expression.trim(), timeZone: recurrence.timeZone },
                { locale },
            );
        }
        case 'unknown':
            return recurrence.rawKind;
    }
}
