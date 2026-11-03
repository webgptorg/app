import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../../testing/fake-clock';
import { RATE_LIMITS, createWindowRateLimiter, isRateLimitRule } from './rate-limiter';

describe('createWindowRateLimiter', () => {
    it('allows up to the limit per window, then reports when the window ends', () => {
        const clock = createFakeClock(1_000);
        const limiter = createWindowRateLimiter({ clock });
        const { limit, windowMs } = RATE_LIMITS['spike-bulk-ip'];
        for (let i = 0; i < limit; i++) expect(limiter.consume('spike-bulk-ip', '203.0.113.7').kind).toBe('allowed');
        clock.advance(10_000);
        expect(limiter.consume('spike-bulk-ip', '203.0.113.7')).toEqual({
            kind: 'limited',
            retryAfterMs: windowMs - 10_000,
        });
    });

    it('counts each key and each rule separately', () => {
        const clock = createFakeClock();
        const limiter = createWindowRateLimiter({ clock });
        for (let i = 0; i < RATE_LIMITS['spike-bulk-ip'].limit; i++) limiter.consume('spike-bulk-ip', 'a');
        expect(limiter.consume('spike-bulk-ip', 'a').kind).toBe('limited');
        expect(limiter.consume('spike-bulk-ip', 'b').kind).toBe('allowed');
        expect(limiter.consume('spike-ip', 'a').kind).toBe('allowed');
    });

    it('starts a new window once windowMs has passed', () => {
        const clock = createFakeClock();
        const limiter = createWindowRateLimiter({ clock });
        const { limit, windowMs } = RATE_LIMITS['spike-bulk-ip'];
        for (let i = 0; i < limit; i++) limiter.consume('spike-bulk-ip', 'a');
        clock.advance(windowMs - 1);
        expect(limiter.consume('spike-bulk-ip', 'a').kind).toBe('limited');
        clock.advance(1);
        expect(limiter.consume('spike-bulk-ip', 'a').kind).toBe('allowed');
    });

    it('gives every key a fresh window once cleared', () => {
        const clock = createFakeClock();
        const limiter = createWindowRateLimiter({ clock });
        for (let i = 0; i < RATE_LIMITS['spike-bulk-ip'].limit; i++) limiter.consume('spike-bulk-ip', 'a');
        expect(limiter.consume('spike-bulk-ip', 'a').kind).toBe('limited');
        limiter.clear();
        expect(limiter.consume('spike-bulk-ip', 'a').kind).toBe('allowed');
    });

    it('refuses new keys beyond maxKeys until old windows expire', () => {
        const clock = createFakeClock();
        const limiter = createWindowRateLimiter({ clock, maxKeys: 2 });
        expect(limiter.consume('spike-ip', 'a').kind).toBe('allowed');
        clock.advance(30_000);
        expect(limiter.consume('spike-ip', 'b').kind).toBe('allowed');
        expect(limiter.consume('spike-ip', 'c')).toEqual({
            kind: 'limited',
            retryAfterMs: RATE_LIMITS['spike-ip'].windowMs,
        });
        // Keys already tracked keep working.
        expect(limiter.consume('spike-ip', 'a').kind).toBe('allowed');
        clock.advance(30_000);
        // `a` expired and is swept, making room for `c`; `b` is still live.
        expect(limiter.consume('spike-ip', 'c').kind).toBe('allowed');
        expect(limiter.consume('spike-ip', 'd').kind).toBe('limited');
    });

    it('defaults to a bounded number of keys', () => {
        const clock = createFakeClock();
        const limiter = createWindowRateLimiter({ clock });
        for (let i = 0; i < 10_000; i++) limiter.consume('spike-ip', `k${String(i)}`);
        expect(limiter.consume('spike-ip', 'one-more').kind).toBe('limited');
    });
});

describe('isRateLimitRule', () => {
    it('knows only the declared rules', () => {
        expect(isRateLimitRule('spike-ip')).toBe(true);
        expect(isRateLimitRule('spike-bulk-ip')).toBe(true);
        expect(isRateLimitRule('toString')).toBe(false);
        expect(isRateLimitRule('unknown')).toBe(false);
    });
});
