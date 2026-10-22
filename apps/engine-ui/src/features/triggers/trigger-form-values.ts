import { MAX_INTERVAL_SECONDS, MAX_MESSAGE_LENGTH, MIN_INTERVAL_SECONDS } from '@ptbk/engine-api';
import type { AgentId, ReadTrigger } from '@ptbk/engine-api';
import { z } from 'zod';

import { m } from '../../paraglide/messages';
import { parseCron } from './schedule/cron';
import type { PreviewSchedule } from './schedule/next-fires';
import { instantOfWallTime, isKnownTimeZone, wallTimeAt } from './schedule/zoned-time';
import type { CreateTriggerBody, UpdateTriggerBody } from './use-trigger-mutations';

export const FORM_KINDS = ['schedule', 'email'] as const;
export const RECURRENCE_KINDS = ['once', 'interval', 'cron'] as const;
export const INTERVAL_UNITS = { minutes: 60, hours: 3_600, days: 86_400 } as const;
export type IntervalUnit = keyof typeof INTERVAL_UNITS;
const UNITS = Object.keys(INTERVAL_UNITS) as [IntervalUnit, ...IntervalUnit[]];

/** `YYYY-MM-DDTHH:MM`, as a `datetime-local` input writes it, read as a wall time in the form's time zone. */
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** The instant a typed date and time names in `timeZone`; `null` when either is not usable. */
export function instantOfLocalInput(value: string, timeZone: string): number | null {
    const match = LOCAL_DATE_TIME.exec(value);
    if (match === null) return null;
    const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
    const check = new Date(Date.UTC(year, month - 1, day, hour, minute));
    // `2026-02-30` would otherwise roll over into March.
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day || hour > 23 || minute > 59) return null;
    return instantOfWallTime({ year, month, day, hour, minute }, timeZone);
}

/** An instant as the `datetime-local` input shows it in `timeZone`. */
export function localInputOf(instant: string, timeZone: string): string {
    const wall = wallTimeAt(Date.parse(instant), timeZone);
    if (wall === null) return '';
    const pad = (value: number, width = 2) => String(value).padStart(width, '0');
    return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

const POSITIVE_INT = /^[1-9]\d{0,8}$/;

/**
 * Every field as the inputs hold it (text), validated together: only the fields of the chosen kind and recurrence
 * count. What the browser cannot judge (a cron the engine's dialect refuses, a range the engine dislikes) is the
 * engine's 422, shown on the same fields.
 */
export const TriggerFormValues = z
    .object({
        kind: z.enum(FORM_KINDS),
        agentId: z.string(),
        name: z.string(),
        recurrence: z.enum(RECURRENCE_KINDS),
        onceAt: z.string(),
        everyAmount: z.string(),
        everyUnit: z.enum(UNITS),
        expression: z.string(),
        timeZone: z.string(),
        startsAt: z.string(),
        endsAt: z.string(),
        maxRunCount: z.string(),
        message: z.string(),
    })
    .superRefine((values, context) => {
        const issue = (path: keyof typeof values, message: string) => {
            context.addIssue({ code: 'custom', path: [path], message });
        };
        if (values.agentId === '') issue('agentId', m.trigger_form_agent_required());
        const name = values.name.trim();
        if (name === '') issue('name', m.trigger_form_name_required());
        else if (name.length > 128) issue('name', m.trigger_form_name_too_long());
        if (values.kind !== 'schedule') return;
        if (!isKnownTimeZone(values.timeZone)) issue('timeZone', m.trigger_form_time_zone_invalid());
        const zone = isKnownTimeZone(values.timeZone) ? values.timeZone : 'UTC';
        switch (values.recurrence) {
            case 'once':
                if (instantOfLocalInput(values.onceAt, zone) === null) issue('onceAt', m.trigger_form_at_required());
                break;
            case 'interval': {
                const seconds = POSITIVE_INT.test(values.everyAmount)
                    ? Number(values.everyAmount) * INTERVAL_UNITS[values.everyUnit]
                    : 0;
                if (seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
                    issue('everyAmount', m.trigger_form_interval_invalid());
                }
                break;
            }
            case 'cron':
                if (parseCron(values.expression) === undefined || values.expression.trim().length > 128) {
                    issue('expression', m.trigger_form_cron_invalid());
                }
                break;
        }
        const starts = values.startsAt === '' ? null : instantOfLocalInput(values.startsAt, zone);
        if (values.startsAt !== '' && starts === null) issue('startsAt', m.trigger_form_date_invalid());
        if (values.endsAt !== '') {
            const ends = instantOfLocalInput(values.endsAt, zone);
            if (ends === null) issue('endsAt', m.trigger_form_date_invalid());
            else if (starts !== null && ends <= starts) issue('endsAt', m.trigger_form_ends_before_starts());
        }
        if (values.maxRunCount !== '' && !POSITIVE_INT.test(values.maxRunCount)) {
            issue('maxRunCount', m.trigger_form_max_runs_invalid());
        }
        if (values.message.trim() === '') issue('message', m.trigger_form_message_required());
        else if (values.message.length > MAX_MESSAGE_LENGTH) issue('message', m.trigger_form_message_too_long());
    });
export type TriggerFormValues = z.input<typeof TriggerFormValues>;

export function emptyFormValues(options: { readonly agentId?: string; readonly timeZone: string }): TriggerFormValues {
    return {
        kind: 'schedule',
        agentId: options.agentId ?? '',
        name: '',
        recurrence: 'cron',
        onceAt: '',
        everyAmount: '1',
        everyUnit: 'hours',
        expression: '0 9 * * 1-5',
        timeZone: options.timeZone,
        startsAt: '',
        endsAt: '',
        maxRunCount: '',
        message: '',
    };
}

function intervalFields(everySeconds: number): Pick<TriggerFormValues, 'everyAmount' | 'everyUnit'> {
    for (const unit of ['days', 'hours', 'minutes'] as const) {
        if (everySeconds % INTERVAL_UNITS[unit] === 0) {
            return { everyAmount: String(everySeconds / INTERVAL_UNITS[unit]), everyUnit: unit };
        }
    }
    // Not a whole number of minutes (the contract allows it): the nearest one, which the member sees before saving.
    return { everyAmount: String(Math.max(1, Math.round(everySeconds / 60))), everyUnit: 'minutes' };
}

/** The form filled from an existing trigger; times read in the schedule's own zone, or the reader's. */
export function formValuesOf(trigger: ReadTrigger, browserTimeZone: string): TriggerFormValues {
    const base = emptyFormValues({ agentId: trigger.agentId, timeZone: browserTimeZone });
    if (trigger.kind !== 'schedule') return { ...base, kind: 'email', name: trigger.name };
    const config = trigger.config;
    const recurrence = config.recurrence;
    const zone = recurrence.kind === 'cron' ? recurrence.timeZone : browserTimeZone;
    const shared = {
        ...base,
        name: trigger.name,
        timeZone: zone,
        startsAt: localInputOf(config.startsAt, zone),
        endsAt: config.endsAt === null ? '' : localInputOf(config.endsAt, zone),
        maxRunCount: config.maxRunCount === null ? '' : String(config.maxRunCount),
        message: config.message,
    };
    switch (recurrence.kind) {
        case 'once':
            return { ...shared, recurrence: 'once', onceAt: localInputOf(recurrence.at, zone) };
        case 'interval':
            return { ...shared, recurrence: 'interval', ...intervalFields(recurrence.everySeconds) };
        case 'cron':
            return { ...shared, recurrence: 'cron', expression: recurrence.expression };
        case 'unknown':
            return shared;
    }
}

type Recurrence = Extract<CreateTriggerBody, { readonly kind: 'schedule' }>['recurrence'];

const iso = (instant: number) => new Date(instant).toISOString();

/** `values` must have passed `TriggerFormValues`; a field it refuses never reaches here. */
function recurrenceOf(values: TriggerFormValues): Recurrence {
    switch (values.recurrence) {
        case 'once':
            return { kind: 'once', at: iso(instantOfLocalInput(values.onceAt, values.timeZone) ?? Number.NaN) };
        case 'interval':
            return {
                kind: 'interval',
                everySeconds: Number(values.everyAmount) * INTERVAL_UNITS[values.everyUnit],
            };
        case 'cron':
            return { kind: 'cron', expression: values.expression.trim(), timeZone: values.timeZone };
    }
}

function rangeOf(values: TriggerFormValues) {
    const starts = values.startsAt === '' ? null : instantOfLocalInput(values.startsAt, values.timeZone);
    const ends = values.endsAt === '' ? null : instantOfLocalInput(values.endsAt, values.timeZone);
    return {
        ...(starts === null ? {} : { startsAt: iso(starts) }),
        endsAt: ends === null ? null : iso(ends),
        maxRunCount: values.maxRunCount === '' ? null : Number(values.maxRunCount),
    };
}

export function createBodyOf(values: TriggerFormValues): CreateTriggerBody {
    const agentId = values.agentId as AgentId;
    const name = values.name.trim();
    if (values.kind === 'email') return { kind: 'email', agentId, name };
    return {
        kind: 'schedule',
        agentId,
        name,
        recurrence: recurrenceOf(values),
        ...rangeOf(values),
        message: values.message,
    };
}

export function updateBodyOf(values: TriggerFormValues): UpdateTriggerBody {
    const name = values.name.trim();
    if (values.kind === 'email') return { name };
    return { name, recurrence: recurrenceOf(values), ...rangeOf(values), message: values.message };
}

const PREVIEW_FIELDS: ReadonlySet<PropertyKey> = new Set<keyof TriggerFormValues>([
    'recurrence',
    'onceAt',
    'everyAmount',
    'everyUnit',
    'expression',
    'timeZone',
    'startsAt',
    'endsAt',
    'maxRunCount',
]);

/** What the preview needs, or `null` while the schedule's own fields cannot describe one; name and message wait. */
export function previewScheduleOf(values: TriggerFormValues, now: number): PreviewSchedule | null {
    if (values.kind !== 'schedule') return null;
    const parsed = TriggerFormValues.safeParse(values);
    if (!parsed.success && parsed.error.issues.some(({ path }) => PREVIEW_FIELDS.has(path[0] ?? ''))) return null;
    const recurrence = recurrenceOf(values);
    const range = rangeOf(values);
    return {
        recurrence: recurrence.kind === 'once' ? { kind: 'once', at: Date.parse(recurrence.at) } : { ...recurrence },
        startsAt: range.startsAt === undefined ? now : Date.parse(range.startsAt),
        endsAt: range.endsAt === null ? null : Date.parse(range.endsAt),
        maxRunCount: range.maxRunCount,
        runCount: 0,
    };
}

const SERVER_FIELDS: Readonly<Record<string, keyof TriggerFormValues>> = {
    'body.agentId': 'agentId',
    'body.name': 'name',
    'body.recurrence': 'recurrence',
    'body.recurrence.at': 'onceAt',
    'body.recurrence.everySeconds': 'everyAmount',
    'body.recurrence.expression': 'expression',
    'body.recurrence.timeZone': 'timeZone',
    'body.startsAt': 'startsAt',
    'body.endsAt': 'endsAt',
    'body.maxRunCount': 'maxRunCount',
    'body.message': 'message',
};

/** The engine's `errors[].path` (`body.recurrence.expression`) as this form's field, or the path when none fits. */
export function formFieldOf(path: string): string {
    return SERVER_FIELDS[path] ?? path;
}
