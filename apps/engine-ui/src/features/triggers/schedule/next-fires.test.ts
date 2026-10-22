import { describe, expect, it } from 'vitest';

import { previewFires } from './next-fires';
import type { PreviewSchedule } from './next-fires';
import { instantOfWallTime, isKnownTimeZone, wallTimeAt } from './zoned-time';

const PRAGUE = 'Europe/Prague';
const ms = (iso: string) => Date.parse(iso);
const isoList = (instants: readonly number[]) => instants.map((at) => new Date(at).toISOString());

function schedule(recurrence: PreviewSchedule['recurrence'], fields: Partial<PreviewSchedule> = {}): PreviewSchedule {
    return { recurrence, startsAt: 0, endsAt: null, maxRunCount: null, runCount: 0, ...fields };
}

const cron = (expression: string, timeZone = PRAGUE) => ({ kind: 'cron', expression, timeZone }) as const;

describe('fire preview', () => {
    it('fires a Prague 02:30 cron twice when October repeats the hour, at both instants', () => {
        const fires = previewFires(schedule(cron('30 2 * * *')), ms('2026-10-24T00:00:00Z'), 4);
        expect(isoList(fires)).toEqual([
            '2026-10-24T00:30:00.000Z', // 02:30 CEST
            '2026-10-25T00:30:00.000Z', // 02:30 CEST, before the clocks go back
            '2026-10-25T01:30:00.000Z', // 02:30 CET, after
            '2026-10-26T01:30:00.000Z',
        ]);
    });

    it('skips a Prague 02:30 cron on the March night the clocks jump from 02:00 to 03:00', () => {
        const fires = previewFires(schedule(cron('30 2 * * *')), ms('2027-03-27T00:00:00Z'), 3);
        expect(isoList(fires)).toEqual([
            '2027-03-27T01:30:00.000Z', // 02:30 CET
            '2027-03-29T00:30:00.000Z', // 02:30 CEST; 28 March has no 02:30
            '2027-03-30T00:30:00.000Z',
        ]);
    });

    it('finds the first minute of the day after the short March day', () => {
        const fires = previewFires(schedule(cron('30 0 * * 1')), ms('2027-03-27T23:30:00Z'), 1);
        expect(isoList(fires)).toEqual(['2027-03-28T22:30:00.000Z']); // Monday 00:30 CEST
    });

    it('reads day of month and weekday as either, like Vixie cron', () => {
        const fires = previewFires(schedule(cron('0 12 13 * 5', 'UTC')), ms('2026-11-01T00:00:00Z'), 4);
        expect(isoList(fires)).toEqual([
            '2026-11-06T12:00:00.000Z',
            '2026-11-13T12:00:00.000Z',
            '2026-11-20T12:00:00.000Z',
            '2026-11-27T12:00:00.000Z',
        ]);
    });

    it('anchors an interval at its start and honours the end and the maximum runs', () => {
        const every15 = { kind: 'interval', everySeconds: 900 } as const;
        const startsAt = ms('2026-10-01T10:05:00Z');
        expect(isoList(previewFires(schedule(every15, { startsAt }), ms('2026-10-01T10:31:00Z'), 3))).toEqual([
            '2026-10-01T10:35:00.000Z',
            '2026-10-01T10:50:00.000Z',
            '2026-10-01T11:05:00.000Z',
        ]);
        expect(previewFires(schedule(every15, { startsAt }), ms('2026-10-01T09:00:00Z'), 1)).toEqual([startsAt]);
        const endsAt = ms('2026-10-01T10:50:00Z');
        expect(previewFires(schedule(every15, { startsAt, endsAt }), startsAt, 5)).toHaveLength(3);
        expect(previewFires(schedule(every15, { startsAt, maxRunCount: 4, runCount: 2 }), startsAt, 5)).toHaveLength(2);
    });

    it('fires a one-off once, and not before its start, after its end or once it ran', () => {
        const at = ms('2026-11-03T09:00:00Z');
        const once = { kind: 'once', at } as const;
        const now = ms('2026-10-01T00:00:00Z');
        expect(previewFires(schedule(once), now, 5)).toEqual([at]);
        expect(previewFires(schedule(once, { runCount: 1 }), now, 5)).toEqual([]);
        expect(previewFires(schedule(once, { endsAt: at }), now, 5)).toEqual([]);
        expect(previewFires(schedule(once), at + 1, 5)).toEqual([]);
    });

    it('previews nothing for a cron it cannot read or that never comes due', () => {
        const now = ms('2026-10-01T00:00:00Z');
        expect(previewFires(schedule(cron('0 8 * * MON')), now, 5)).toEqual([]);
        expect(previewFires(schedule(cron('0 0 30 2 *')), now, 5)).toEqual([]);
        expect(previewFires(schedule(cron('0 8 * * *', 'Mars/Olympus')), now, 5)).toEqual([]);
    });
});

describe('zoned wall times', () => {
    it('reads the wall clock in a zone as Intl computes it', () => {
        expect(wallTimeAt(ms('2026-10-25T00:30:00Z'), PRAGUE)).toEqual({
            year: 2026,
            month: 10,
            day: 25,
            hour: 2,
            minute: 30,
            weekday: 0,
        });
        expect(wallTimeAt(0, 'Mars/Olympus')).toBeNull();
        expect(isKnownTimeZone(PRAGUE)).toBe(true);
        expect(isKnownTimeZone('')).toBe(false);
    });

    it('turns a typed wall time into its instant, the first one when the hour repeats', () => {
        const wall = (day: number, month: number, hour: number, minute = 0) => ({
            year: 2026,
            month,
            day,
            hour,
            minute,
        });
        expect(instantOfWallTime(wall(3, 11, 10), PRAGUE)).toBe(ms('2026-11-03T09:00:00Z'));
        expect(instantOfWallTime(wall(1, 7, 10), PRAGUE)).toBe(ms('2026-07-01T08:00:00Z'));
        expect(instantOfWallTime(wall(25, 10, 2, 30), PRAGUE)).toBe(ms('2026-10-25T00:30:00Z'));
        expect(instantOfWallTime({ ...wall(28, 3, 2, 30), year: 2027 }, PRAGUE)).toBe(ms('2027-03-28T01:30:00Z'));
        expect(instantOfWallTime(wall(1, 7, 10), 'Mars/Olympus')).toBeNull();
    });
});
