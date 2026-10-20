import { describe, expect, it } from 'vitest';
import { createFixedClock } from './clock';

describe('createFixedClock', () => {
    it('always returns the same instant', () => {
        const clock = createFixedClock(new Date('2026-10-20T08:00:00Z'));
        expect(clock.now().toISOString()).toBe('2026-10-20T08:00:00.000Z');
        expect(clock.now().getTime()).toBe(clock.now().getTime());
    });

    it('cannot be moved through a returned date or the original', () => {
        const original = new Date('2026-10-20T08:00:00Z');
        const clock = createFixedClock(original);
        clock.now().setTime(0);
        original.setTime(0);
        expect(clock.now().toISOString()).toBe('2026-10-20T08:00:00.000Z');
    });

    it('refuses an invalid date', () => {
        expect(() => createFixedClock(new Date('not a date'))).toThrow(RangeError);
    });
});
