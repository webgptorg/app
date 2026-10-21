import { describe, expect, it } from 'vitest';

import { createTestDeps } from '../../testing/test-deps';
import type { ConnectionPoolLimits, PendingEnd, PooledConnection } from './connection-pool';
import { createConnectionPool } from './connection-pool';
import type { IpLimits } from './ip-limiter';
import { createIpLimiter } from './ip-limiter';

const limits: ConnectionPoolLimits = {
    maxConnections: 100,
    maxPending: 10,
    reserved: 10,
    clientHelloTimeoutMs: 5000,
    pressureClientHelloTimeoutMs: 1000,
};

interface Tracked {
    readonly connection: PooledConnection;
    ended: PendingEnd | null;
}

function setup(overrides: Partial<ConnectionPoolLimits> = {}) {
    const { clock } = createTestDeps();
    const pool = createConnectionPool({ ...limits, ...overrides }, clock);
    const admit = (): Tracked => {
        const admission = pool.admit((reason) => {
            tracked.ended = reason;
        });
        if (admission.kind === 'refused') throw new Error('expected an admission');
        const tracked: Tracked = { connection: admission.connection, ended: null };
        return tracked;
    };
    return { clock, pool, admit };
}

describe('createConnectionPool', () => {
    it('times a pending connection out after the ClientHello timeout and frees its slot at once', () => {
        const { clock, pool, admit } = setup();
        const slow = admit();
        clock.advance(4999);
        expect(slow.ended).toBeNull();
        clock.advance(1);
        expect(slow.ended).toBe('timeout');
        expect(pool.connections()).toBe(0);
        // Its close comes later and changes nothing.
        slow.connection.release();
        expect(pool.connections()).toBe(0);
        expect(slow.connection.route('own')).toBe(false);
    });

    it('stops the deadline once the ClientHello is judged, and counts the connection until it closes', () => {
        const { clock, pool, admit } = setup();
        const routed = admit();
        expect(routed.connection.route('own')).toBe(true);
        expect(routed.connection.route('engine')).toBe(false);
        expect(pool.pending()).toBe(0);
        clock.advance(60_000);
        expect(routed.ended).toBeNull();
        expect(pool.connections()).toBe(1);
        routed.connection.release();
        routed.connection.release();
        expect(pool.connections()).toBe(0);
    });

    it('evicts the oldest pending connection once the pending budget is full', () => {
        const { pool, admit } = setup({ pressureClientHelloTimeoutMs: 60_000 });
        const pending = Array.from({ length: 10 }, admit);
        const newcomer = admit();
        expect(pending.map((tracked) => tracked.ended)).toEqual(['evicted', ...new Array<null>(9).fill(null)]);
        expect(newcomer.ended).toBeNull();
        expect(pool.pending()).toBe(10);
        expect(pool.connections()).toBe(10);
        // A pending connection that closes on its own leaves room without an eviction.
        pending[1]?.connection.release();
        admit();
        expect(pending[2]?.ended).toBeNull();
    });

    it('drops the ClientHello timeout to the pressure timeout above 80% of the pending budget, oldest first', () => {
        const { clock, pool, admit } = setup();
        const first = Array.from({ length: 8 }, admit);
        clock.advance(500);
        const late = admit();
        // 9 of 10: above 80%. The first eight are due at 1000 ms, the late one at 1500 ms.
        clock.advance(499);
        expect(first.every((tracked) => tracked.ended === null)).toBe(true);
        clock.advance(1);
        // Ended in accept order until the pool is back at 80%: one is enough.
        expect(first.map((tracked) => tracked.ended)).toEqual(['timeout', ...new Array<null>(7).fill(null)]);
        expect(pool.pending()).toBe(8);
        // Back above 80%: the oldest are long past the pressure timeout, the newest still within it.
        const newest = admit();
        clock.advance(0);
        expect(first.filter((tracked) => tracked.ended === 'timeout')).toHaveLength(2);
        expect(late.ended).toBeNull();
        expect(newest.ended).toBeNull();
        // Not under pressure: the normal timeout applies to the rest.
        clock.advance(3999);
        expect(late.ended).toBeNull();
        clock.advance(1000);
        expect([late.ended, newest.ended]).toEqual(['timeout', null]);
    });

    it('refuses with global-limit only when every connection is past its ClientHello', () => {
        const { pool, admit } = setup({ maxConnections: 3, maxPending: 3, reserved: 1 });
        const own = admit();
        own.connection.route('own');
        const browsers = [admit(), admit()];
        for (const browser of browsers) expect(browser.connection.route('engine')).toBe(true);
        expect(pool.admit(() => undefined)).toEqual({ kind: 'refused', reason: 'global-limit' });
        browsers[0]?.connection.release();
        const pending = admit();
        // At the cap with one pending: a newcomer evicts it.
        const newcomer = admit();
        expect([pending.ended, newcomer.ended]).toEqual(['evicted', null]);
    });

    it('keeps the reserve for the relay hostname: engine-bound connections stop at the cap minus the reserve', () => {
        const { pool, admit } = setup({ maxConnections: 4, maxPending: 4, reserved: 2 });
        const routes = [admit(), admit(), admit()].map((tracked) => tracked.connection.route('engine'));
        expect(routes).toEqual([true, true, false]);
        // The refused one is still open until its socket closes.
        expect(pool.connections()).toBe(3);
        const engine = admit();
        expect(engine.connection.route('own')).toBe(true);
        expect(pool.connections()).toBe(4);
    });

    it(
        'admits a prompt browser and an engine through a pre-ClientHello flood from many IPv4 addresses and from ' +
            'many /64s inside one /48',
        () => {
            const { clock } = createTestDeps();
            const ipLimits: IpLimits = {
                maxConnectionsPerIp: 4,
                maxConnectionsPerIpv6Slash56: 16,
                maxConnectionsPerIpv6Slash48: 64,
                newConnectionsPerIpPerS: 4,
            };
            const ips = createIpLimiter(ipLimits, clock);
            const pool = createConnectionPool(
                {
                    maxConnections: 1000,
                    maxPending: 250,
                    reserved: 100,
                    clientHelloTimeoutMs: 5000,
                    pressureClientHelloTimeoutMs: 1000,
                },
                clock,
            );
            const refusals = new Map<string, number>();
            const count = (reason: string): void => {
                refusals.set(reason, (refusals.get(reason) ?? 0) + 1);
            };
            /** Admits like the listener: per source first, then the pool; `null` if refused. */
            const connect = (ip: string): { readonly route: PooledConnection['route']; ended(): boolean } | null => {
                const source = ips.admit(ip);
                if (source.kind === 'refused') {
                    count(source.reason);
                    return null;
                }
                let ended = false;
                const admission = pool.admit((reason) => {
                    ended = true;
                    count(reason);
                    source.release();
                });
                if (admission.kind === 'refused') {
                    source.release();
                    count(admission.reason);
                    return null;
                }
                return { route: (destination) => admission.connection.route(destination), ended: () => ended };
            };

            const browserIp = (index: number): string => `198.51.${String(index >> 8)}.${String(index & 0xff)}`;
            // Browsers already on engine streams take most of their share.
            for (let index = 0; index < 600; index++) expect(connect(browserIp(index))?.route('engine')).toBe(true);
            for (let round = 0; round < 20; round++) {
                // Every 100 ms: 500 idle connections from fresh IPv4 addresses and 500 from fresh /64s of one /48.
                for (let index = 0; index < 500; index++) {
                    connect(`10.${String(round)}.${String(index >> 8)}.${String(index & 0xff)}`);
                }
                for (let index = 0; index < 500; index++) {
                    // Spread over the /56s, so the /48 cap is the one that bites.
                    const n = round * 500 + index;
                    connect(`2001:db8:66:${(((n & 0xff) << 8) | (n >> 8)).toString(16)}::1`);
                }
                // A browser that sends its ClientHello promptly is never the oldest pending one: it gets through.
                const browser = connect(`203.0.113.${String(round)}`);
                expect(browser?.ended()).toBe(false);
                expect(browser?.route('engine')).toBe(true);
                clock.advance(100);
            }
            expect(refusals.get('evicted')).toBeGreaterThan(10_000);
            expect(refusals.get('ipv6-48-limit')).toBeGreaterThan(0);
            expect(refusals.get('global-limit')).toBeUndefined();

            // Browsers fill the rest of their share; during the flood an engine still reaches the relay hostname.
            for (let index = 600; index < 880; index++) expect(connect(browserIp(index))?.route('engine')).toBe(true);
            for (let index = 0; index < 500; index++) connect(`10.99.${String(index >> 8)}.${String(index & 0xff)}`);
            expect(connect('203.0.113.200')?.route('engine')).toBe(false);
            const engine = connect('192.0.2.50');
            expect(engine?.ended()).toBe(false);
            expect(engine?.route('own')).toBe(true);
        },
    );
});
