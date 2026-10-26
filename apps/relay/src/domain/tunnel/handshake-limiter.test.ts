import { describe, expect, it } from 'vitest';

import { createTestDeps } from '../../testing/test-deps';
import type { Admission } from './handshake-limiter';
import { createHandshakeLimiter } from './handshake-limiter';

const createFakeClock = () => createTestDeps().clock;

const verdicts = (admissions: readonly (Admission | null)[]): readonly (string | null)[] =>
    admissions.map((admission) => admission?.verdict ?? null);

describe('createHandshakeLimiter', () => {
    it('admits up to the per-IP limit, then rate-limits as many again, then drops', () => {
        const limiter = createHandshakeLimiter(
            { maxPending: 100, maxPendingPerIp: 2, handshakesPerIpPerMin: 1000 },
            createFakeClock(),
        );
        const fromA = Array.from({ length: 5 }, () => limiter.admit('192.0.2.1'));
        expect(verdicts(fromA)).toEqual(['admitted', 'admitted', 'rate-limited', 'rate-limited', null]);
        expect(limiter.admit('192.0.2.2')?.verdict).toBe('admitted');
    });

    it('applies the global limit across IPs', () => {
        const limiter = createHandshakeLimiter(
            { maxPending: 2, maxPendingPerIp: 10, handshakesPerIpPerMin: 1000 },
            createFakeClock(),
        );
        const admissions = ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4', '192.0.2.5'].map((ip) =>
            limiter.admit(ip),
        );
        expect(verdicts(admissions)).toEqual(['admitted', 'admitted', 'rate-limited', 'rate-limited', null]);
    });

    it('frees a slot on release, once, for that IP only', () => {
        const limiter = createHandshakeLimiter(
            { maxPending: 100, maxPendingPerIp: 2, handshakesPerIpPerMin: 1000 },
            createFakeClock(),
        );
        const first = limiter.admit('192.0.2.1');
        limiter.admit('192.0.2.1');
        first?.release();
        first?.release();
        expect(limiter.admit('192.0.2.1')?.verdict).toBe('admitted');
        expect(limiter.admit('192.0.2.1')?.verdict).toBe('rate-limited');
    });

    it('frees rate-limited slots separately', () => {
        const limiter = createHandshakeLimiter(
            { maxPending: 1, maxPendingPerIp: 1, handshakesPerIpPerMin: 1000 },
            createFakeClock(),
        );
        const admitted = limiter.admit('192.0.2.1');
        const refused = limiter.admit('192.0.2.1');
        expect(limiter.admit('192.0.2.1')).toBeNull();
        refused?.release();
        expect(limiter.admit('192.0.2.1')?.verdict).toBe('rate-limited');
        admitted?.release();
        expect(limiter.admit('192.0.2.1')?.verdict).toBe('admitted');
    });

    it('counts an IPv6 /64 as one client', () => {
        const limiter = createHandshakeLimiter(
            { maxPending: 100, maxPendingPerIp: 1, handshakesPerIpPerMin: 1000 },
            createFakeClock(),
        );
        expect(verdicts([limiter.admit('2001:db8:1:2::1'), limiter.admit('2001:db8:1:2::ffff')])).toEqual([
            'admitted',
            'rate-limited',
        ]);
        expect(limiter.admit('2001:db8:1:3::1')?.verdict).toBe('admitted');
    });

    it('rate-limits one address past its handshakes per minute, until its bucket refills', () => {
        const clock = createFakeClock();
        const limiter = createHandshakeLimiter(
            { maxPending: 100, maxPendingPerIp: 100, handshakesPerIpPerMin: 3 },
            clock,
        );
        const fromA = Array.from({ length: 4 }, () => limiter.admit('192.0.2.1'));
        for (const admission of fromA) admission?.release();
        expect(verdicts(fromA)).toEqual(['admitted', 'admitted', 'admitted', 'rate-limited']);
        expect(limiter.admit('2001:db8:1:2::1')?.verdict).toBe('admitted');
        clock.advance(20_000);
        expect(limiter.admit('192.0.2.1')?.verdict).toBe('admitted');
        expect(limiter.admit('192.0.2.1')?.verdict).toBe('rate-limited');
    });

    it('does not spend the rate on a connection the pending limit refuses anyway', () => {
        const clock = createFakeClock();
        const limiter = createHandshakeLimiter(
            { maxPending: 100, maxPendingPerIp: 1, handshakesPerIpPerMin: 2 },
            clock,
        );
        const held = limiter.admit('192.0.2.1');
        expect(limiter.admit('192.0.2.1')?.verdict).toBe('rate-limited');
        held?.release();
        expect(verdicts([limiter.admit('192.0.2.1')])).toEqual(['admitted']);
    });

    it('forgets addresses whose rate bucket is full again, and keeps those still refilling', () => {
        const clock = createFakeClock();
        const limiter = createHandshakeLimiter(
            { maxPending: 10_000, maxPendingPerIp: 10, handshakesPerIpPerMin: 60 },
            clock,
        );
        for (let index = 0; index < 1023; index++) {
            limiter.admit(`10.0.${String(Math.floor(index / 256))}.${String(index % 256)}`)?.release();
        }
        clock.advance(60_000);
        limiter.admit('198.51.100.1')?.release();
        expect(limiter.trackedIps()).toBe(1024);
        limiter.admit('203.0.113.1');
        expect(limiter.trackedIps()).toBe(2);
    });
});
