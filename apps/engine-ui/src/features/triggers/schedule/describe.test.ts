import { describe, expect, it } from 'vitest';

import type { Locale } from '../../../paraglide/runtime';
import { parseCron } from './cron';
import { describeRecurrence } from './describe';
import type { DescribedRecurrence } from './describe';

const PRAGUE = 'Europe/Prague';

/** ICU versions differ on where Czech puts a no-break space (`a\u00a0neděle`); the words are what is tested. */
function describeIn(locale: Locale, recurrence: DescribedRecurrence): string {
    return describeRecurrence(recurrence, { locale, displayTimeZone: PRAGUE }).replaceAll('\u00a0', ' ');
}

const cron = (expression: string): DescribedRecurrence => ({ kind: 'cron', expression, timeZone: PRAGUE });

describe('schedule descriptions', () => {
    it('describes a one-off time in the reader’s zone', () => {
        const once = { kind: 'once', at: '2026-11-03T09:00:00.000Z' } as const;
        expect(describeIn('en', once)).toBe('Once on November 3, 2026 at 10:00');
        expect(describeIn('cs', once)).toBe('Jednou, 3. listopadu 2026 v 10:00');
    });

    it('describes intervals in the largest whole unit, with plurals', () => {
        const every = (everySeconds: number) => ({ kind: 'interval', everySeconds }) as const;
        expect(describeIn('en', every(900))).toBe('Every 15 minutes');
        expect(describeIn('en', every(3_600))).toBe('Every hour');
        expect(describeIn('en', every(7_200))).toBe('Every 2 hours');
        expect(describeIn('en', every(86_400 * 3))).toBe('Every 3 days');
        expect(describeIn('en', every(90))).toBe('Every 90 seconds');
        expect(describeIn('cs', every(900))).toBe('Každých 15 minut');
        expect(describeIn('cs', every(60))).toBe('Každou minutu');
        expect(describeIn('cs', every(7_200))).toBe('Každé 2 hodiny');
        expect(describeIn('cs', every(86_400 * 5))).toBe('Každých 5 dní');
    });

    it('describes the cron shapes people write, with the schedule’s zone', () => {
        const cases: readonly (readonly [string, string, string])[] = [
            ['0 8 * * 1-5', 'Every weekday at 08:00, Europe/Prague', 'Každý pracovní den v 08:00, Europe/Prague'],
            ['*/15 * * * *', 'Every 15 minutes, Europe/Prague', 'Každých 15 minut, Europe/Prague'],
            ['0 */2 * * *', 'Every 2 hours, Europe/Prague', 'Každé 2 hodiny, Europe/Prague'],
            ['5 * * * *', 'Every hour at minute 5, Europe/Prague', 'Každou hodinu v 5. minutě, Europe/Prague'],
            ['30 2 * * *', 'Every day at 02:30, Europe/Prague', 'Každý den v 02:30, Europe/Prague'],
            [
                '0 9 * * 0,1,3',
                'Every Monday, Wednesday, and Sunday at 09:00, Europe/Prague',
                'Každý týden (pondělí, středa a neděle) v 09:00, Europe/Prague',
            ],
            ['0 9 * * 7', 'Every Sunday at 09:00, Europe/Prague', 'Každý týden (neděle) v 09:00, Europe/Prague'],
            ['15 6 1 * *', 'Every month on day 1 at 06:15, Europe/Prague', 'Každý měsíc 1. den v 06:15, Europe/Prague'],
            [
                '0 10 3 11 *',
                'Every year on November 3 at 10:00, Europe/Prague',
                'Každý rok 3. listopadu v 10:00, Europe/Prague',
            ],
        ];
        for (const [expression, en, cs] of cases) {
            expect(describeIn('en', cron(expression))).toBe(en);
            expect(describeIn('cs', cron(expression))).toBe(cs);
        }
    });

    it('shows a cron it cannot put in words, or cannot read, as written', () => {
        for (const expression of [
            '0 8 1-7 * 1',
            '0 8,20 * * *',
            '0 8 L * *',
            '0 8 * * MON',
            '0 0 8 * * *',
            'every day',
        ]) {
            expect(describeIn('en', cron(` ${expression} `))).toBe(`${expression}, Europe/Prague`);
            expect(describeIn('cs', cron(expression))).toBe(`${expression}, Europe/Prague`);
        }
    });

    it('shows a newer engine’s recurrence kind by its raw name', () => {
        expect(describeIn('en', { kind: 'unknown', rawKind: 'sunrise' })).toBe('sunrise');
    });
});

describe('cron parsing', () => {
    it('reads numbers, ranges, lists and steps, with 7 as Sunday', () => {
        const parsed = parseCron('0,30 8-10 */10 1-12/3 5-7');
        expect(parsed?.minute.values).toEqual([0, 30]);
        expect(parsed?.hour.values).toEqual([8, 9, 10]);
        expect(parsed?.day.values).toEqual([1, 11, 21, 31]);
        expect(parsed?.month.values).toEqual([1, 4, 7, 10]);
        expect(parsed?.weekday.values).toEqual([0, 5, 6]);
        expect(parseCron('5/20 * * * *')?.minute.values).toEqual([5, 25, 45]);
    });

    it('refuses what the engine’s dialect does not have, out-of-range values and empty steps', () => {
        for (const expression of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8']) {
            expect(parseCron(expression)).toBeUndefined();
        }
        for (const expression of ['*/0 * * * *', '5-1 * * * *', '? * * * *', 'L * * * *', '1W * * * *']) {
            expect(parseCron(expression)).toBeUndefined();
        }
    });
});
