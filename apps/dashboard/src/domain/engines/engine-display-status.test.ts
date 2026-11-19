import { EngineVersion, Timestamp } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { EngineStatusSnapshot } from '../status/engine-status';
import { deriveEngineDisplayStatus } from './engine-display-status';

const SEEN = {
    lastSeenAt: 1_800_000_000_000,
    lastSeq: 7,
    payload: {
        ts: Timestamp.parse('2027-01-15T08:00:00Z'),
        receivedAt: 1_800_000_000_000,
        version: EngineVersion.parse('1.4.2'),
        uptimeS: 60,
        diskPct: 40,
        ramPct: 70,
        cpuLoad: 'low',
        update: 'none',
        agents: 3,
        members: 2,
    },
} as const;
const online: EngineStatusSnapshot = { state: 'online', ...SEEN };
const offline: EngineStatusSnapshot = { state: 'offline', ...SEEN, offlineSince: SEEN.lastSeenAt + 195_000 };
const neverSeen: EngineStatusSnapshot = { state: 'never-seen' };

describe('deriveEngineDisplayStatus', () => {
    it.each([
        ['online', online],
        ['offline', offline],
        ['never-seen', neverSeen],
    ] as const)('shows an active engine as %s from its heartbeats', (expected, snapshot) => {
        expect(deriveEngineDisplayStatus({ status: 'active' }, snapshot)).toBe(expected);
    });

    it('shows an online engine without members as waiting for its owner', () => {
        const ownerPending: EngineStatusSnapshot = { ...online, payload: { ...SEEN.payload, members: 0 } };
        expect(deriveEngineDisplayStatus({ status: 'active' }, ownerPending)).toBe('owner-pending');
        expect(deriveEngineDisplayStatus({ status: 'suspended' }, ownerPending)).toBe('suspended');
    });

    it('shows an online engine with an owner and an unfinished setup as setup-pending, and a finished one online', () => {
        const pending: EngineStatusSnapshot = { ...online, payload: { ...SEEN.payload, setup: 'pending' } };
        expect(deriveEngineDisplayStatus({ status: 'active' }, pending)).toBe('setup-pending');
        expect(deriveEngineDisplayStatus({ status: 'suspended' }, pending)).toBe('suspended');
        const done: EngineStatusSnapshot = { ...online, payload: { ...SEEN.payload, setup: 'done' } };
        expect(deriveEngineDisplayStatus({ status: 'active' }, done)).toBe('online');
    });

    it('asks for the owner before the setup, and keeps an offline engine with an unfinished setup offline', () => {
        const ownerless: EngineStatusSnapshot = {
            ...online,
            payload: { ...SEEN.payload, members: 0, setup: 'pending' },
        };
        expect(deriveEngineDisplayStatus({ status: 'active' }, ownerless)).toBe('owner-pending');
        const away: EngineStatusSnapshot = { ...offline, payload: { ...SEEN.payload, setup: 'pending' } };
        expect(deriveEngineDisplayStatus({ status: 'active' }, away)).toBe('offline');
    });

    it('keeps an offline engine without members offline, and an online one without numbers online', () => {
        const ownerless: EngineStatusSnapshot = { ...offline, payload: { ...SEEN.payload, members: 0 } };
        expect(deriveEngineDisplayStatus({ status: 'active' }, ownerless)).toBe('offline');
        expect(deriveEngineDisplayStatus({ status: 'active' }, { ...online, payload: null })).toBe('online');
    });

    it('shows unknown when the status object did not answer', () => {
        expect(deriveEngineDisplayStatus({ status: 'active' }, null)).toBe('unknown');
    });

    it.each([online, offline, neverSeen, null])('lets a suspension win over any heartbeat state', (snapshot) => {
        expect(deriveEngineDisplayStatus({ status: 'suspended' }, snapshot)).toBe('suspended');
    });
});
