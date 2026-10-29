import { TriggerReader } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { m } from '../../paraglide/messages';
import {
    createBodyOf,
    emptyFormValues,
    formFieldOf,
    formValuesOf,
    instantOfLocalInput,
    localInputOf,
    presetCron,
    presetOf,
    previewScheduleOf,
    TriggerFormValues,
    updateBodyOf,
} from './trigger-form-values';
import type { TriggerFormValues as Values } from './trigger-form-values';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');

const valid = (overrides: Partial<Values> = {}): Values => ({
    ...emptyFormValues({ agentId: 'agent-ada', timeZone: 'Europe/Prague' }),
    name: 'Weekly report',
    message: 'Write the weekly report',
    ...overrides,
});

/** The schema's messages by field, for the values given. */
function issues(values: Values): Record<string, string> {
    const result = TriggerFormValues.safeParse(values);
    return Object.fromEntries(
        (result.error?.issues ?? []).map((issue) => [String(issue.path[0]), issue.message] as const),
    );
}

function readTrigger(fields: Record<string, unknown>) {
    return TriggerReader.parse({
        id: 'trigger-1',
        agentId: 'agent-ada',
        agentName: 'Ada',
        name: 'Weekly report',
        lifecycle: 'active',
        endedReason: null,
        lastFiredAt: null,
        nextFireAt: null,
        createdBy: 'member-owner',
        createdAt: '2026-09-01T00:00:00.000Z',
        updatedAt: '2026-09-01T00:00:00.000Z',
        ...fields,
    });
}

const schedule = (recurrence: Record<string, unknown>, config: Record<string, unknown> = {}) =>
    readTrigger({
        kind: 'schedule',
        config: {
            recurrence,
            startsAt: '2026-10-01T08:00:00.000Z',
            endsAt: null,
            maxRunCount: null,
            runCount: 0,
            message: 'Write the weekly report',
            ...config,
        },
    });

describe('local date and time inputs', () => {
    it('reads a wall time in the zone and refuses what no calendar has', () => {
        expect(instantOfLocalInput('2026-10-01T10:00', 'Europe/Prague')).toBe(Date.parse('2026-10-01T08:00:00Z'));
        expect(instantOfLocalInput('2026-02-30T10:00', 'UTC')).toBeNull();
        expect(instantOfLocalInput('2026-10-01T24:00', 'UTC')).toBeNull();
        expect(instantOfLocalInput('2026-10-01T10:60', 'UTC')).toBeNull();
        expect(instantOfLocalInput('tomorrow', 'UTC')).toBeNull();
    });

    it('shows an instant as the input writes it, and nothing for an unknown zone', () => {
        expect(localInputOf('2026-10-01T08:05:00.000Z', 'Europe/Prague')).toBe('2026-10-01T10:05');
        expect(localInputOf('2026-10-01T08:05:00.000Z', 'Mars/Olympus')).toBe('');
    });
});

describe('the trigger form schema', () => {
    it('accepts a complete schedule of each recurrence and a bare email trigger', () => {
        expect(issues(valid())).toEqual({});
        expect(issues(valid({ recurrence: 'once', onceAt: '2026-10-02T09:00' }))).toEqual({});
        expect(issues(valid({ recurrence: 'interval', everyAmount: '2', everyUnit: 'hours' }))).toEqual({});
        expect(issues(valid({ kind: 'email', message: '', expression: 'nonsense' }))).toEqual({});
    });

    it('names every field that is missing or out of range', () => {
        expect(issues(valid({ agentId: '', name: ' ', message: ' ' }))).toEqual({
            agentId: m.trigger_form_agent_required(),
            name: m.trigger_form_name_required(),
            message: m.trigger_form_message_required(),
        });
        expect(issues(valid({ name: 'x'.repeat(129), message: 'x'.repeat(70_000) }))).toEqual({
            name: m.trigger_form_name_too_long(),
            message: m.trigger_form_message_too_long(),
        });
        expect(issues(valid({ timeZone: 'Mars/Olympus' }))).toEqual({ timeZone: m.trigger_form_time_zone_invalid() });
        expect(issues(valid({ recurrence: 'once', onceAt: '' }))).toEqual({ onceAt: m.trigger_form_at_required() });
        expect(issues(valid({ recurrence: 'interval', everyAmount: 'x' }))).toEqual({
            everyAmount: m.trigger_form_interval_invalid(),
        });
        expect(issues(valid({ recurrence: 'interval', everyAmount: '400', everyUnit: 'days' }))).toEqual({
            everyAmount: m.trigger_form_interval_invalid(),
        });
        expect(issues(valid({ recurrence: 'cron', expression: 'every monday' }))).toEqual({
            expression: m.trigger_form_cron_invalid(),
        });
        expect(issues(valid({ recurrence: 'daily', atTime: '' }))).toEqual({ atTime: m.trigger_form_time_required() });
        expect(issues(valid({ recurrence: 'weekly', atTime: '24:00' }))).toEqual({
            atTime: m.trigger_form_time_required(),
        });
        expect(issues(valid({ maxRunCount: '0' }))).toEqual({ maxRunCount: m.trigger_form_max_runs_invalid() });
    });

    it('checks the range: dates that exist, and an end after the start', () => {
        expect(issues(valid({ startsAt: 'soon', endsAt: 'later' }))).toEqual({
            startsAt: m.trigger_form_date_invalid(),
            endsAt: m.trigger_form_date_invalid(),
        });
        expect(issues(valid({ startsAt: '2026-10-05T09:00', endsAt: '2026-10-04T09:00' }))).toEqual({
            endsAt: m.trigger_form_ends_before_starts(),
        });
        expect(issues(valid({ startsAt: '', endsAt: '2026-10-04T09:00' }))).toEqual({});
    });
});

describe('form values from a trigger', () => {
    it('fills an email trigger with its name only', () => {
        const values = formValuesOf(
            readTrigger({ kind: 'email', config: { address: 'ada@engine.example' } }),
            'Europe/Prague',
        );
        expect(values).toMatchObject({ kind: 'email', name: 'Weekly report', agentId: 'agent-ada' });
    });

    it('reads a cron schedule in its own zone, with its range', () => {
        const values = formValuesOf(
            schedule(
                { kind: 'cron', expression: '*/15 9-17 * * 1-5', timeZone: 'America/New_York' },
                { endsAt: '2026-12-01T14:00:00.000Z', maxRunCount: 10 },
            ),
            'Europe/Prague',
        );
        expect(values).toMatchObject({
            recurrence: 'cron',
            expression: '*/15 9-17 * * 1-5',
            timeZone: 'America/New_York',
            startsAt: '2026-10-01T04:00',
            endsAt: '2026-12-01T09:00',
            maxRunCount: '10',
        });
    });

    it('reads once and interval schedules in the reader’s zone, in the largest whole unit', () => {
        expect(formValuesOf(schedule({ kind: 'once', at: '2026-10-03T07:30:00.000Z' }), 'Europe/Prague')).toMatchObject(
            { recurrence: 'once', onceAt: '2026-10-03T09:30', timeZone: 'Europe/Prague' },
        );
        expect(formValuesOf(schedule({ kind: 'interval', everySeconds: 172_800 }), 'UTC')).toMatchObject({
            everyAmount: '2',
            everyUnit: 'days',
        });
        expect(formValuesOf(schedule({ kind: 'interval', everySeconds: 5_400 }), 'UTC')).toMatchObject({
            everyAmount: '90',
            everyUnit: 'minutes',
        });
        expect(formValuesOf(schedule({ kind: 'interval', everySeconds: 90 }), 'UTC')).toMatchObject({
            everyAmount: '2',
            everyUnit: 'minutes',
        });
    });

    it('opens a cron the form would write as its preset, keeping the zone', () => {
        const cron = (expression: string) =>
            formValuesOf(schedule({ kind: 'cron', expression, timeZone: 'America/New_York' }), 'Europe/Prague');
        expect(cron('0 9 * * 1')).toMatchObject({
            recurrence: 'weekly',
            atTime: '09:00',
            weekday: '1',
            timeZone: 'America/New_York',
        });
        expect(cron(' 30  7 * * 1-5 ')).toMatchObject({ recurrence: 'weekdays', atTime: '07:30' });
        expect(cron('5 18 * * *')).toMatchObject({ recurrence: 'daily', atTime: '18:05' });
        expect(cron('0 * * * *')).toMatchObject({ recurrence: 'hourly' });
    });

    it('keeps the shared fields of a recurrence this client does not know', () => {
        const values = formValuesOf(schedule({ kind: 'lunar', phase: 'full' }), 'UTC');
        expect(values).toMatchObject({ message: 'Write the weekly report' });
    });
});

describe('schedule presets', () => {
    it('write the cron each preset stands for, minute first', () => {
        expect(presetCron('hourly', '', '1')).toBe('0 * * * *');
        expect(presetCron('daily', '07:05', '1')).toBe('5 7 * * *');
        expect(presetCron('weekdays', '09:00', '1')).toBe('0 9 * * 1-5');
        expect(presetCron('weekly', '23:59', '0')).toBe('59 23 * * 0');
        expect(presetCron('daily', '7:05', '1')).toBeUndefined();
        expect(presetCron('weekly', '', '3')).toBeUndefined();
    });

    it('read back every cron they write, and nothing else', () => {
        for (const atTime of ['00:00', '09:30', '23:59']) {
            for (const recurrence of ['daily', 'weekdays', 'weekly'] as const) {
                const expression = presetCron(recurrence, atTime, '3');
                expect(presetOf(expression ?? '')).toEqual({
                    recurrence,
                    atTime,
                    weekday: recurrence === 'weekly' ? '3' : '1',
                });
            }
        }
        for (const custom of [
            '0 9 * * 1,2,3,4,5',
            '00 09 * * 1-5',
            '0 9 * * 7',
            '15 * * * *',
            '0 9 1 * *',
            '0 9 * 1 *',
            '0 24 * * *',
            '60 9 * * *',
            '*/15 * * * *',
            'every monday',
        ]) {
            expect(presetOf(custom)).toBeUndefined();
        }
    });

    it('send a preset as the cron in its zone', () => {
        expect(createBodyOf(valid())).toMatchObject({
            recurrence: { kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'Europe/Prague' },
        });
        expect(updateBodyOf(valid({ recurrence: 'weekly', atTime: '08:15', weekday: '5' }))).toMatchObject({
            recurrence: { kind: 'cron', expression: '15 8 * * 5', timeZone: 'Europe/Prague' },
        });
        expect(createBodyOf(valid({ recurrence: 'hourly', atTime: '' }))).toMatchObject({
            recurrence: { kind: 'cron', expression: '0 * * * *' },
        });
    });
});

describe('request bodies', () => {
    it('sends an email trigger as its kind, agent and trimmed name', () => {
        const values = valid({ kind: 'email', name: '  Inbox ' });
        expect(createBodyOf(values)).toEqual({ kind: 'email', agentId: 'agent-ada', name: 'Inbox' });
        expect(updateBodyOf(values)).toEqual({ name: 'Inbox' });
    });

    it('sends each recurrence with its range in UTC', () => {
        expect(
            createBodyOf(
                valid({
                    recurrence: 'once',
                    onceAt: '2026-10-02T09:00',
                    startsAt: '2026-10-01T09:00',
                    endsAt: '2026-10-10T09:00',
                    maxRunCount: '3',
                }),
            ),
        ).toEqual({
            kind: 'schedule',
            agentId: 'agent-ada',
            name: 'Weekly report',
            recurrence: { kind: 'once', at: '2026-10-02T07:00:00.000Z' },
            startsAt: '2026-10-01T07:00:00.000Z',
            endsAt: '2026-10-10T07:00:00.000Z',
            maxRunCount: 3,
            message: 'Write the weekly report',
        });
        expect(updateBodyOf(valid({ recurrence: 'interval', everyAmount: '15', everyUnit: 'minutes' }))).toEqual({
            name: 'Weekly report',
            recurrence: { kind: 'interval', everySeconds: 900 },
            endsAt: null,
            maxRunCount: null,
            message: 'Write the weekly report',
        });
        expect(createBodyOf(valid({ recurrence: 'cron', expression: ' 0 9 * * 1-5 ' }))).toMatchObject({
            recurrence: { kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'Europe/Prague' },
        });
    });
});

describe('the schedule preview', () => {
    it('has nothing to show for an email trigger or a schedule its own fields cannot describe', () => {
        expect(previewScheduleOf(valid({ kind: 'email' }), NOW)).toBeNull();
        expect(previewScheduleOf(valid({ recurrence: 'cron', expression: 'nonsense' }), NOW)).toBeNull();
        expect(previewScheduleOf(valid({ recurrence: 'daily', atTime: '' }), NOW)).toBeNull();
    });

    it('waits for no name or message, starts now without a start, and reads a one-off as an instant', () => {
        expect(previewScheduleOf(valid({ name: '', message: '' }), NOW)).toEqual({
            recurrence: { kind: 'cron', expression: '0 9 * * 1-5', timeZone: 'Europe/Prague' },
            startsAt: NOW,
            endsAt: null,
            maxRunCount: null,
            runCount: 0,
        });
        expect(
            previewScheduleOf(
                valid({
                    recurrence: 'once',
                    onceAt: '2026-10-02T09:00',
                    startsAt: '2026-10-01T09:00',
                    endsAt: '2026-10-03T09:00',
                }),
                NOW,
            ),
        ).toEqual({
            recurrence: { kind: 'once', at: Date.parse('2026-10-02T07:00:00Z') },
            startsAt: Date.parse('2026-10-01T07:00:00Z'),
            endsAt: Date.parse('2026-10-03T07:00:00Z'),
            maxRunCount: null,
            runCount: 0,
        });
    });
});

describe('server field paths', () => {
    it('maps the engine’s body paths onto form fields and keeps any other path', () => {
        expect(formFieldOf('body.recurrence.expression', 'cron')).toBe('expression');
        expect(formFieldOf('body.recurrence.everySeconds', 'interval')).toBe('everyAmount');
        expect(formFieldOf('body.somethingNew', 'cron')).toBe('body.somethingNew');
    });

    it('puts an expression error of a preset on the field the member sees', () => {
        expect(formFieldOf('body.recurrence.expression', 'weekly')).toBe('atTime');
        expect(formFieldOf('body.recurrence.expression', 'hourly')).toBe('recurrence');
        expect(formFieldOf('body.recurrence.timeZone', 'daily')).toBe('timeZone');
    });
});
