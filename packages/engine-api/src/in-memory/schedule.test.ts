import { describe, expect, it } from 'vitest';

import { Recurrence, ScheduleConfig } from '../capabilities/triggers';
import type { Recurrence as RecurrenceType } from '../capabilities/triggers';
import { nextFireAt, scheduleProblem } from './schedule';

// 2026-10-19 is a Monday; Prague is on CEST (UTC+2) until 2026-10-25.
const MONDAY = '2026-10-19T10:00:00Z';

const cron = (expression: string, timeZone = 'UTC'): RecurrenceType =>
    Recurrence.parse({ kind: 'cron', expression, timeZone });

function config(recurrence: RecurrenceType, fields: Partial<Record<string, unknown>> = {}) {
    return ScheduleConfig.parse({
        recurrence,
        startsAt: '2026-10-19T00:00:00Z',
        endsAt: null,
        maxRunCount: null,
        runCount: 0,
        message: 'Go',
        ...fields,
    });
}

describe('scheduleProblem', () => {
    const interval = Recurrence.parse({ kind: 'interval', everySeconds: 3600 });

    it('refuses an end at or before the start', () => {
        expect(scheduleProblem(interval, MONDAY, MONDAY, MONDAY)?.message).toMatch(/endsAt/);
        expect(scheduleProblem(interval, MONDAY, '2026-10-19T09:00:00Z', MONDAY)?.message).toMatch(/endsAt/);
        expect(scheduleProblem(interval, MONDAY, null, MONDAY)).toBeUndefined();
    });

    it('places a one-off time in the future and inside the range', () => {
        const once = (at: string) => Recurrence.parse({ kind: 'once', at });
        expect(scheduleProblem(once('2026-10-19T09:00:00Z'), MONDAY, null, MONDAY)?.message).toMatch(/past/);
        expect(scheduleProblem(once('2026-10-19T11:00:00Z'), '2026-10-19T12:00:00Z', null, MONDAY)?.message).toMatch(
            /before startsAt/,
        );
        expect(scheduleProblem(once('2026-10-19T12:00:00Z'), MONDAY, '2026-10-19T12:00:00Z', MONDAY)?.message).toMatch(
            /after endsAt/,
        );
        expect(scheduleProblem(once('2026-10-19T11:00:00Z'), MONDAY, '2026-10-19T12:00:00Z', MONDAY)).toBeUndefined();
    });

    it.each([
        ['four fields', '00 00 01 01'],
        ['six fields', '* * * * * *'],
        ['minute out of range', '60 * * * *'],
        ['month zero', '0 0 1 0 *'],
        ['zero step', '*/0 * * * *'],
        ['reversed range', '0 5-2 * * *'],
        ['day names', '0 9 * * MON'],
        ['garbage', '0 9 * * ?x'],
    ])('refuses %s', (_label, expression) => {
        expect(scheduleProblem(cron(expression), MONDAY, null, MONDAY)?.message).toMatch(/cron/);
    });

    it('refuses an unknown time zone and an expression that never fires', () => {
        expect(scheduleProblem(cron('0 9 * * *', 'Mars/Olympus'), MONDAY, null, MONDAY)?.message).toMatch(/time zone/);
        expect(scheduleProblem(cron('0 0 30 2 *'), MONDAY, null, MONDAY)?.message).toMatch(/never fires/);
    });

    it('names the field at fault', () => {
        const paths = [
            scheduleProblem(interval, MONDAY, MONDAY, MONDAY),
            scheduleProblem(Recurrence.parse({ kind: 'once', at: '2026-10-19T09:00:00Z' }), MONDAY, null, MONDAY),
            scheduleProblem(cron('61 * * * *'), MONDAY, null, MONDAY),
            scheduleProblem(cron('0 0 30 2 *'), MONDAY, null, MONDAY),
            scheduleProblem(cron('0 9 * * *', 'Mars/Olympus'), MONDAY, null, MONDAY),
        ].map((problem) => problem?.path);
        expect(paths).toEqual([
            'body.endsAt',
            'body.recurrence.at',
            'body.recurrence.expression',
            'body.recurrence.expression',
            'body.recurrence.timeZone',
        ]);
    });

    it('accepts working hours in Prague', () => {
        expect(scheduleProblem(cron('*/15 9-17 * * 1-5', 'Europe/Prague'), MONDAY, null, MONDAY)).toBeUndefined();
    });
});

describe('nextFireAt', () => {
    it('fires a one-off schedule once', () => {
        const once = Recurrence.parse({ kind: 'once', at: '2026-10-20T08:00:00Z' });
        expect(nextFireAt(config(once), MONDAY, null)).toBe('2026-10-20T08:00:00.000Z');
        expect(nextFireAt(config(once, { runCount: 1 }), MONDAY, '2026-10-20T08:00:00Z')).toBeNull();
    });

    it('anchors intervals at startsAt and moves strictly past the last fire', () => {
        const hourly = Recurrence.parse({ kind: 'interval', everySeconds: 3600 });
        expect(nextFireAt(config(hourly), '2026-10-19T01:30:00Z', null)).toBe('2026-10-19T02:00:00.000Z');
        expect(nextFireAt(config(hourly), '2026-10-18T22:00:00Z', null)).toBe('2026-10-19T00:00:00.000Z');
        expect(nextFireAt(config(hourly), '2026-10-19T02:00:00Z', '2026-10-19T02:00:00Z')).toBe(
            '2026-10-19T03:00:00.000Z',
        );
    });

    it('stops at endsAt and maxRunCount', () => {
        const hourly = Recurrence.parse({ kind: 'interval', everySeconds: 3600 });
        expect(
            nextFireAt(
                config(hourly, { endsAt: '2026-10-19T02:30:00Z' }),
                '2026-10-19T02:00:00Z',
                '2026-10-19T02:00:00Z',
            ),
        ).toBeNull();
        expect(nextFireAt(config(hourly, { maxRunCount: 2, runCount: 2 }), MONDAY, null)).toBeNull();
        expect(nextFireAt(config(hourly, { maxRunCount: 2, runCount: 1 }), MONDAY, null)).toBe(
            '2026-10-19T10:00:00.000Z',
        );
    });

    it('evaluates cron in UTC', () => {
        expect(nextFireAt(config(cron('30 9 * * *')), MONDAY, null)).toBe('2026-10-20T09:30:00.000Z');
        expect(nextFireAt(config(cron('5/20 * * * *')), MONDAY, null)).toBe('2026-10-19T10:05:00.000Z');
        expect(nextFireAt(config(cron('0 0 1,15 * *')), MONDAY, null)).toBe('2026-11-01T00:00:00.000Z');
    });

    it('finds the next listed minute however the list is ordered, also in a half-hour zone', () => {
        expect(nextFireAt(config(cron('45,5 * * * *')), MONDAY, null)).toBe('2026-10-19T10:05:00.000Z');
        expect(nextFireAt(config(cron('45,5 * * * *')), '2026-10-19T10:05:00Z', '2026-10-19T10:05:00Z')).toBe(
            '2026-10-19T10:45:00.000Z',
        );
        // 15 past the hour in Kolkata (UTC+5:30) is 45 past in UTC.
        expect(nextFireAt(config(cron('15 * * * *', 'Asia/Kolkata')), MONDAY, null)).toBe('2026-10-19T10:45:00.000Z');
    });

    it('evaluates cron in the schedule time zone', () => {
        expect(nextFireAt(config(cron('0 9 * * *', 'Europe/Prague')), MONDAY, null)).toBe('2026-10-20T07:00:00.000Z');
        // After the switch to CET (UTC+1) on 25 October the same local time is an hour later in UTC.
        expect(nextFireAt(config(cron('0 9 * * 1', 'Europe/Prague')), MONDAY, null)).toBe('2026-10-26T08:00:00.000Z');
    });

    it('matches either day field when both are restricted, and treats 7 as Sunday', () => {
        expect(nextFireAt(config(cron('0 0 20 * 0')), MONDAY, null)).toBe('2026-10-20T00:00:00.000Z');
        expect(nextFireAt(config(cron('0 0 1 * 0')), MONDAY, null)).toBe('2026-10-25T00:00:00.000Z');
        expect(nextFireAt(config(cron('0 0 * * 7')), MONDAY, null)).toBe('2026-10-25T00:00:00.000Z');
        expect(nextFireAt(config(cron('0 0 31 * *')), MONDAY, null)).toBe('2026-10-31T00:00:00.000Z');
    });

    it('gives null for a cron that cannot be evaluated', () => {
        expect(nextFireAt(config(cron('0 9 * * *', 'Mars/Olympus')), MONDAY, null)).toBeNull();
        expect(nextFireAt(config(cron('not a cron')), MONDAY, null)).toBeNull();
    });
});
