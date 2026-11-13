import { describe, expect, it } from 'vitest';

import { formatClock } from './elapsed';

describe('formatClock', () => {
    it.each([
        [0, '0:00'],
        [-5000, '0:00'],
        [8_400, '0:08'],
        [252_000, '4:12'],
        [3_807_000, '1:03:27'],
    ])('%i ms reads %s', (ms, clock) => {
        expect(formatClock(ms)).toBe(clock);
    });
});
