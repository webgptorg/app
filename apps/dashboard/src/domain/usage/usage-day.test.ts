import { describe, expect, it } from 'vitest';

import { dayStartMs, monthsBefore, nextDay, previousDay, usageDaySchema, utcDay } from './usage-day';

describe('usage days', () => {
    it('are UTC calendar days, whatever the time within them', () => {
        expect(utcDay(Date.UTC(2027, 0, 15))).toBe('2027-01-15');
        expect(utcDay(Date.UTC(2027, 0, 15, 23, 59, 59, 999))).toBe('2027-01-15');
        expect(dayStartMs(usageDaySchema.parse('2027-01-15'))).toBe(Date.UTC(2027, 0, 15));
    });

    it('step across month and year ends', () => {
        expect(previousDay(usageDaySchema.parse('2027-01-01'))).toBe('2026-12-31');
        expect(nextDay(usageDaySchema.parse('2028-02-28'))).toBe('2028-02-29');
    });

    it('refuse anything but a date', () => {
        expect(usageDaySchema.safeParse('2027-1-5').success).toBe(false);
        expect(usageDaySchema.safeParse("2027-01-15' OR 1=1").success).toBe(false);
    });

    it('count retention in calendar months', () => {
        expect(monthsBefore(Date.UTC(2027, 0, 15, 12), 13)).toBe(Date.UTC(2025, 11, 15, 12));
        expect(monthsBefore(Date.UTC(2027, 0, 15), 25)).toBe(Date.UTC(2024, 11, 15));
    });
});
