import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../fake-clock';
import { createMemoryRateLimiter } from './memory-rate-limiter';

const signal = new AbortController().signal;

describe('memory rate limiter', () => {
    it('counts each rule and key separately, per its window', async () => {
        const clock = createFakeClock(0);
        const limiter = createMemoryRateLimiter(clock);
        for (let i = 0; i < 3; i++) {
            expect(await limiter.consume('signup-start-email', 'a@example.test', signal)).toBe('allowed');
        }
        expect(await limiter.consume('signup-start-email', 'a@example.test', signal)).toBe('limited');
        expect(await limiter.consume('signup-start-email', 'b@example.test', signal)).toBe('allowed');
        expect(await limiter.consume('recovery-request-email', 'a@example.test', signal)).toBe('allowed');
        clock.advance(60 * 60 * 1000);
        expect(await limiter.consume('signup-start-email', 'a@example.test', signal)).toBe('allowed');
    });
});
