import type { EngineId, Hostname, TunnelCloseCode } from '@ptbk/protocol';
import { EngineId as EngineIdSchema, Hostname as HostnameSchema, TUNNEL_CLOSE_CODE } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDeps } from '../../testing/test-deps';
import type { SessionTable, TableSession } from './session-table';
import { createSessionTable } from './session-table';

interface FakeSession extends TableSession {
    readonly closes: TunnelCloseCode[];
}

const engineA: EngineId = EngineIdSchema.parse('a'.repeat(26));
const engineB: EngineId = EngineIdSchema.parse('b'.repeat(26));
const host = (name: string): Hostname => HostnameSchema.parse(name);
const defaultA = host(`${engineA}.engine.test`);
const defaultB = host(`${engineB}.engine.test`);
const shared = host('agents.customer.test');

function session(engineId: EngineId, remoteIp = '198.51.100.1'): FakeSession {
    const closes: TunnelCloseCode[] = [];
    return { engineId, remoteIp, closes, close: (code) => closes.push(code) };
}

describe('createSessionTable', () => {
    let logger: ReturnType<typeof createTestDeps>['logger'];
    let table: SessionTable<FakeSession>;

    beforeEach(() => {
        ({ logger } = createTestDeps());
        table = createSessionTable<FakeSession>({ logger });
    });

    it('finds a registered session by engine and by each of its hostnames', () => {
        const a = session(engineA);
        table.register(a, [defaultA, shared, shared]);
        expect(table.byEngine(engineA)).toBe(a);
        expect(table.byHostname(defaultA)).toBe(a);
        expect(table.byHostname(shared)).toBe(a);
        expect(table.byHostname(defaultB)).toBeUndefined();
        expect(table.hostnamesOf(a)).toEqual([defaultA, shared]);
        expect(table.sessions()).toEqual([a]);
    });

    it('replaces the tunnel of the same engine, closing the old one with REPLACED', () => {
        const old = session(engineA, '198.51.100.1');
        const next = session(engineA, '198.51.100.2');
        table.register(old, [defaultA, shared]);
        table.register(next, [defaultA]);
        expect(old.closes).toEqual([TUNNEL_CLOSE_CODE.REPLACED]);
        expect(table.byEngine(engineA)).toBe(next);
        expect(table.byHostname(defaultA)).toBe(next);
        expect(table.byHostname(shared)).toBeUndefined();
        expect(table.countByIp('198.51.100.1')).toBe(0);
        expect(table.countByIp('198.51.100.2')).toBe(1);
        table.remove(old);
        expect(table.byEngine(engineA)).toBe(next);
        expect(logger.entries).toEqual([]);
    });

    it('ignores registering the same session twice', () => {
        const a = session(engineA);
        table.register(a, [defaultA]);
        table.register(a, [defaultA]);
        expect(a.closes).toEqual([]);
        expect(table.countByIp(a.remoteIp)).toBe(1);
    });

    it('routes by the new hostnames after an update and ignores updates for unregistered sessions', () => {
        const a = session(engineA);
        table.register(a, [defaultA, shared]);
        table.updateHostnames(a, [defaultA]);
        expect(table.byHostname(shared)).toBeUndefined();
        expect(table.byHostname(defaultA)).toBe(a);
        table.updateHostnames(session(engineB), [shared]);
        expect(table.byHostname(shared)).toBeUndefined();
    });

    it('clears every hostname on removal', () => {
        const a = session(engineA);
        table.register(a, [defaultA, shared]);
        table.remove(a);
        expect(table.byEngine(engineA)).toBeUndefined();
        expect(table.byHostname(defaultA)).toBeUndefined();
        expect(table.byHostname(shared)).toBeUndefined();
        expect(table.hostnamesOf(a)).toEqual([]);
        expect(table.sessions()).toEqual([]);
        expect(table.countByIp(a.remoteIp)).toBe(0);
    });

    it('routes neither of two engines claiming one hostname and logs the conflict without the hostname', () => {
        const a = session(engineA);
        const b = session(engineB);
        table.register(a, [defaultA, shared]);
        table.register(b, [defaultB, shared]);
        expect(table.byHostname(shared)).toBeUndefined();
        expect(table.byHostname(defaultA)).toBe(a);
        expect(table.byHostname(defaultB)).toBe(b);
        expect(logger.entries).toEqual([
            { level: 'warn', event: 'hostname.conflict', fields: { engineId: engineB, otherEngineId: engineA } },
        ]);
        expect(JSON.stringify(logger.entries)).not.toContain(shared);
        table.updateHostnames(b, [defaultB, shared]);
        expect(logger.entries).toHaveLength(1);
        table.remove(a);
        expect(table.byHostname(shared)).toBe(b);
    });

    it('routes the hostname again once a revalidation drops it from one engine', () => {
        const a = session(engineA);
        const b = session(engineB);
        table.register(a, [defaultA, shared]);
        table.register(b, [defaultB, shared]);
        table.updateHostnames(a, [defaultA]);
        expect(table.byHostname(shared)).toBe(b);
    });

    it('counts tunnels per client IP', () => {
        table.register(session(engineA, '198.51.100.1'), [defaultA]);
        table.register(session(engineB, '198.51.100.1'), [defaultB]);
        expect(table.countByIp('198.51.100.1')).toBe(2);
        expect(table.countByIp('198.51.100.9')).toBe(0);
    });

    it('counts tunnels per IPv6 /64', () => {
        const a = session(engineA, '2001:db8:1:2::1');
        table.register(a, [defaultA]);
        table.register(session(engineB, '2001:db8:1:2::2'), [defaultB]);
        expect(table.countByIp('2001:db8:1:2::ffff')).toBe(2);
        expect(table.countByIp('2001:db8:1:3::1')).toBe(0);
        table.remove(a);
        expect(table.countByIp('2001:db8:1:2::1')).toBe(1);
    });
});
