import { describe, expect, it } from 'vitest';

import { createTestDeps } from '../../testing/test-deps';
import type { Clock } from '../clock';
import { createTokenBucket } from './token-bucket';

const createFakeClock = () => createTestDeps().clock;

describe('createTokenBucket', () => {
    it('starts full and refuses once empty', () => {
        const clock = createFakeClock();
        const bucket = createTokenBucket({ capacity: 3, refillPerSecond: 1, clock });
        expect([1, 2, 3, 4].map(() => bucket.tryTake(1))).toEqual([true, true, true, false]);
    });

    it('refills continuously at the rate, up to the capacity', () => {
        const clock = createFakeClock();
        const bucket = createTokenBucket({ capacity: 2, refillPerSecond: 4, clock });
        bucket.tryTake(2);
        clock.advance(249);
        expect(bucket.tryTake(1)).toBe(false);
        clock.advance(1);
        expect(bucket.tryTake(1)).toBe(true);
        expect(bucket.isFull()).toBe(false);
        clock.advance(10_000);
        expect(bucket.isFull()).toBe(true);
        expect([1, 2, 3].map(() => bucket.tryTake(1))).toEqual([true, true, false]);
    });

    it('goes into debt for byte budgets and says how long to wait', () => {
        const clock = createFakeClock();
        const bucket = createTokenBucket({ capacity: 1000, refillPerSecond: 1000, clock });
        expect(bucket.takeOrWait(600)).toBe(0);
        expect(bucket.takeOrWait(600)).toBe(200);
        expect(bucket.takeOrWait(300)).toBe(500);
        clock.advance(500);
        expect(bucket.takeOrWait(1)).toBe(1);
        expect(bucket.tryTake(1)).toBe(false);
    });

    it('refills nothing when the clock steps backwards', () => {
        let nowMs = 10_000;
        const clock: Clock = { nowMs: () => nowMs, setTimeout: () => () => undefined };
        const bucket = createTokenBucket({ capacity: 1, refillPerSecond: 1, clock });
        bucket.tryTake(1);
        nowMs = 5_000;
        expect(bucket.tryTake(1)).toBe(false);
        nowMs = 10_999;
        expect(bucket.tryTake(1)).toBe(false);
        nowMs = 11_000;
        expect(bucket.tryTake(1)).toBe(true);
    });

    it('refuses a non-positive capacity or rate', () => {
        const clock = createFakeClock();
        expect(() => createTokenBucket({ capacity: 0, refillPerSecond: 1, clock })).toThrow(RangeError);
        expect(() => createTokenBucket({ capacity: 1, refillPerSecond: 0, clock })).toThrow(RangeError);
    });
});
