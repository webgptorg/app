import { describe, expect, it } from 'vitest';

import { createTestDeps } from '../../testing/test-deps';
import type { IpAdmission, IpLimits } from './ip-limiter';
import { createIpLimiter } from './ip-limiter';

const limits: IpLimits = { maxConnections: 100, maxConnectionsPerIp: 2, newConnectionsPerIpPerS: 4 };

function setup(overrides: Partial<IpLimits> = {}) {
    const { clock } = createTestDeps();
    return { clock, limiter: createIpLimiter({ ...limits, ...overrides }, clock) };
}

const kinds = (admissions: readonly IpAdmission[]): readonly string[] =>
    admissions.map((admission) => (admission.kind === 'admitted' ? 'admitted' : admission.reason));

function release(admission: IpAdmission | undefined): void {
    if (admission?.kind !== 'admitted') throw new Error('expected an admission');
    admission.release();
}

describe('createIpLimiter', () => {
    it('caps open connections per IP and frees a slot on close, once', () => {
        const { limiter } = setup();
        const admissions = [1, 2, 3].map(() => limiter.admit('192.0.2.1'));
        expect(kinds(admissions)).toEqual(['admitted', 'admitted', 'ip-limit']);
        expect(limiter.admit('192.0.2.2').kind).toBe('admitted');
        release(admissions[0]);
        release(admissions[0]);
        expect(limiter.connections()).toBe(2);
        expect(limiter.admit('192.0.2.1').kind).toBe('admitted');
        expect(limiter.admit('192.0.2.1')).toEqual({ kind: 'refused', reason: 'ip-limit' });
    });

    it('limits new connections per IP per second with a refilling bucket', () => {
        const { clock, limiter } = setup({ maxConnectionsPerIp: 100 });
        expect(kinds([1, 2, 3, 4, 5].map(() => limiter.admit('192.0.2.1')))).toEqual([
            'admitted',
            'admitted',
            'admitted',
            'admitted',
            'ip-rate',
        ]);
        expect(limiter.admit('192.0.2.9').kind).toBe('admitted');
        clock.advance(249);
        expect(limiter.admit('192.0.2.1').kind).toBe('refused');
        clock.advance(1);
        expect(limiter.admit('192.0.2.1').kind).toBe('admitted');
    });

    it('keeps the rate of an IP that disconnects, so reconnecting does not reset it', () => {
        const { limiter } = setup({ maxConnectionsPerIp: 100, newConnectionsPerIpPerS: 1 });
        release(limiter.admit('192.0.2.1'));
        expect(limiter.admit('192.0.2.1')).toEqual({ kind: 'refused', reason: 'ip-rate' });
    });

    it('counts an IPv6 /64 as one client', () => {
        const { limiter } = setup();
        expect(
            kinds([
                limiter.admit('2001:db8:1:2::1'),
                limiter.admit('2001:db8:1:2:ffff::2'),
                limiter.admit('2001:db8:1:2:abcd:1:2:3'),
                limiter.admit('2001:db8:1:3::1'),
            ]),
        ).toEqual(['admitted', 'admitted', 'ip-limit', 'admitted']);
    });

    it('applies the global limit across IPs before anything else', () => {
        const { limiter } = setup({ maxConnections: 2 });
        const admissions = ['192.0.2.1', '192.0.2.2', '192.0.2.3'].map((ip) => limiter.admit(ip));
        expect(kinds(admissions)).toEqual(['admitted', 'admitted', 'global-limit']);
        release(admissions[1]);
        expect(limiter.admit('192.0.2.3').kind).toBe('admitted');
    });

    it('forgets idle IPs once their bucket is full again, so memory follows live clients', () => {
        const { clock, limiter } = setup({ maxConnections: 10_000, newConnectionsPerIpPerS: 1 });
        const held = limiter.admit('198.51.100.1');
        for (let index = 0; index < 1023; index++) {
            release(limiter.admit(`10.0.${String(Math.floor(index / 256))}.${String(index % 256)}`));
        }
        expect(limiter.trackedIps()).toBe(1024);
        // Still refilling: the next admission sweeps, but nothing may go yet.
        limiter.admit('203.0.113.1');
        expect(limiter.trackedIps()).toBe(1025);
        clock.advance(1000);
        for (let index = 0; index < 1023; index++)
            limiter.admit(`10.1.${String(Math.floor(index / 256))}.${String(index % 256)}`);
        limiter.admit('203.0.113.2');
        // Swept at 2048: the refilled idle IPs went; the held one and the newer ones stay.
        expect(limiter.trackedIps()).toBe(1 + 1 + 1023 + 1);
        expect(held.kind).toBe('admitted');
        expect(limiter.admit('198.51.100.1').kind).toBe('admitted');
    });
});
