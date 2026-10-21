import { describe, expect, it } from 'vitest';

import type { Admission } from './handshake-limiter';
import { createHandshakeLimiter } from './handshake-limiter';

const verdicts = (admissions: readonly (Admission | null)[]): readonly (string | null)[] =>
    admissions.map((admission) => admission?.verdict ?? null);

describe('createHandshakeLimiter', () => {
    it('admits up to the per-IP limit, then rate-limits as many again, then drops', () => {
        const limiter = createHandshakeLimiter({ maxPending: 100, maxPendingPerIp: 2 });
        const fromA = Array.from({ length: 5 }, () => limiter.admit('192.0.2.1'));
        expect(verdicts(fromA)).toEqual(['admitted', 'admitted', 'rate-limited', 'rate-limited', null]);
        expect(limiter.admit('192.0.2.2')?.verdict).toBe('admitted');
    });

    it('applies the global limit across IPs', () => {
        const limiter = createHandshakeLimiter({ maxPending: 2, maxPendingPerIp: 10 });
        const admissions = ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4', '192.0.2.5'].map((ip) =>
            limiter.admit(ip),
        );
        expect(verdicts(admissions)).toEqual(['admitted', 'admitted', 'rate-limited', 'rate-limited', null]);
    });

    it('frees a slot on release, once, for that IP only', () => {
        const limiter = createHandshakeLimiter({ maxPending: 100, maxPendingPerIp: 2 });
        const first = limiter.admit('192.0.2.1');
        limiter.admit('192.0.2.1');
        first?.release();
        first?.release();
        expect(limiter.admit('192.0.2.1')?.verdict).toBe('admitted');
        expect(limiter.admit('192.0.2.1')?.verdict).toBe('rate-limited');
    });

    it('frees rate-limited slots separately', () => {
        const limiter = createHandshakeLimiter({ maxPending: 1, maxPendingPerIp: 1 });
        const admitted = limiter.admit('192.0.2.1');
        const refused = limiter.admit('192.0.2.1');
        expect(limiter.admit('192.0.2.1')).toBeNull();
        refused?.release();
        expect(limiter.admit('192.0.2.1')?.verdict).toBe('rate-limited');
        admitted?.release();
        expect(limiter.admit('192.0.2.1')?.verdict).toBe('admitted');
    });

    it('counts an IPv6 /64 as one client', () => {
        const limiter = createHandshakeLimiter({ maxPending: 100, maxPendingPerIp: 1 });
        expect(verdicts([limiter.admit('2001:db8:1:2::1'), limiter.admit('2001:db8:1:2::ffff')])).toEqual([
            'admitted',
            'rate-limited',
        ]);
        expect(limiter.admit('2001:db8:1:3::1')?.verdict).toBe('admitted');
    });
});
