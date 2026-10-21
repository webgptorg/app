import { describe, expect, it } from 'vitest';

import { createTestDeps } from '../../testing/test-deps';
import type { IpAdmission, IpLimits } from './ip-limiter';
import { createIpLimiter } from './ip-limiter';

const limits: IpLimits = {
    maxConnectionsPerIp: 2,
    maxConnectionsPerIpv6Slash56: 3,
    maxConnectionsPerIpv6Slash48: 4,
    newConnectionsPerIpPerS: 4,
};

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
        const { limiter } = setup({ maxConnectionsPerIpv6Slash56: 100, maxConnectionsPerIpv6Slash48: 100 });
        expect(
            kinds([
                limiter.admit('2001:db8:1:2::1'),
                limiter.admit('2001:db8:1:2:ffff::2'),
                limiter.admit('2001:db8:1:2:abcd:1:2:3'),
                limiter.admit('2001:db8:1:3::1'),
            ]),
        ).toEqual(['admitted', 'admitted', 'ip-limit', 'admitted']);
    });

    it('caps the /64s of one /56 and of one /48 together, and frees every level on release', () => {
        const { limiter } = setup({ maxConnectionsPerIp: 100, newConnectionsPerIpPerS: 100 });
        // Four /64s in one /56: the /56 cap (3) refuses the fourth.
        const inSlash56 = ['2001:db8:1:200::1', '2001:db8:1:201::1', '2001:db8:1:2ff::1', '2001:db8:1:2aa::1'].map(
            (ip) => limiter.admit(ip),
        );
        expect(kinds(inSlash56)).toEqual(['admitted', 'admitted', 'admitted', 'ipv6-56-limit']);
        // Another /56 of the same /48 has room for one more before the /48 cap (4).
        expect(kinds([limiter.admit('2001:db8:1:300::1'), limiter.admit('2001:db8:1:301::1')])).toEqual([
            'admitted',
            'ipv6-48-limit',
        ]);
        expect(limiter.admit('2001:db8:2::1').kind).toBe('admitted');
        release(inSlash56[0]);
        expect(limiter.admit('2001:db8:1:2aa::1').kind).toBe('admitted');
    });

    it('forgets idle IPs and prefixes once their buckets are full again, so memory follows live clients', () => {
        const { clock, limiter } = setup({ newConnectionsPerIpPerS: 1 });
        const held = limiter.admit('198.51.100.1');
        release(limiter.admit('2001:db8:9::1'));
        for (let index = 0; index < 1020; index++) {
            release(limiter.admit(`10.0.${String(Math.floor(index / 256))}.${String(index % 256)}`));
        }
        // The address, its /64 and the IPv6 address's /56 and /48.
        expect(limiter.trackedIps()).toBe(1024);
        // Still refilling: the next admission sweeps only the idle prefixes, which have no rate.
        limiter.admit('203.0.113.1');
        expect(limiter.trackedIps()).toBe(1023);
        clock.advance(1000);
        for (let index = 0; index < 1025; index++) {
            limiter.admit(`10.1.${String(Math.floor(index / 256))}.${String(index % 256)}`);
        }
        limiter.admit('203.0.113.2');
        // Swept again once the count doubled: the refilled idle IPs went; the held ones and the newer ones stay.
        expect(limiter.trackedIps()).toBe(1 + 1 + 1025 + 1);
        expect(held.kind).toBe('admitted');
        expect(limiter.admit('198.51.100.1').kind).toBe('admitted');
    });
});
