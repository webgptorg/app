import { afterEach, describe, expect, it } from 'vitest';

import { getLocale, overwriteGetLocale } from '../../paraglide/runtime';

const baseGetLocale = getLocale;
import { formatDuration } from './run-format';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function durationIn(locale: 'en' | 'cs', ms: number): string {
    overwriteGetLocale(() => locale);
    return formatDuration(ms, (value) => new Intl.NumberFormat(locale).format(value)).replaceAll(' ', ' ');
}

afterEach(() => {
    overwriteGetLocale(baseGetLocale);
});

describe('formatDuration', () => {
    it('shows the two largest units', () => {
        expect(durationIn('en', 45 * SECOND + 900)).toBe('45 s');
        expect(durationIn('en', 3 * MINUTE + 5 * SECOND)).toBe('3 min 5 s');
        expect(durationIn('en', 2 * HOUR + 7 * MINUTE + 59 * SECOND)).toBe('2 h 7 min');
        expect(durationIn('en', -5 * SECOND)).toBe('0 s');
    });

    it('counts days past 24 hours instead of hundreds of hours', () => {
        expect(durationIn('en', 610 * HOUR + 3 * MINUTE)).toBe('25 d 10 h');
        expect(durationIn('en', DAY)).toBe('1 d 0 h');
        expect(durationIn('en', 1234 * DAY)).toBe('1,234 d 0 h');
        expect(durationIn('cs', 610 * HOUR + 3 * MINUTE)).toBe('25 d 10 h');
        expect(durationIn('cs', 3 * MINUTE + 5 * SECOND)).toBe('3 min 5 s');
        expect(durationIn('cs', 1234 * DAY + HOUR)).toBe('1 234 d 1 h');
    });
});
