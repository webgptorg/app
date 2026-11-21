import { describe, expect, it } from 'vitest';

import type { AnyHeartbeat, HeartbeatInput } from '@ptbk/protocol';

import { createTestEngine } from '../../testing/test-engine';
import { heartbeatInput } from '../../testing/test-heartbeat';
import { countHeartbeat } from './engine-activity';

const NOON = Date.UTC(2027, 0, 15, 12);

async function heartbeat(overrides: Partial<HeartbeatInput> = {}): Promise<AnyHeartbeat> {
    const engine = await createTestEngine();
    return { v: 1, ...heartbeatInput(engine, 1, NOON), diskPct: 40, ramPct: 70, ...overrides };
}

describe('engine activity', () => {
    it('starts a day with the heartbeat’s numbers, and counts the rest of the day onto it', async () => {
        const first = countHeartbeat(undefined, await heartbeat({ setup: 'pending' }), NOON);
        expect(first).toEqual({
            current: {
                day: '2027-01-15',
                beats: 1,
                firstBeatAt: NOON,
                lastBeatAt: NOON,
                engineVersion: '1.4.2',
                agents: 3,
                members: 2,
                setup: 'pending',
                updateState: 'none',
                cpuLoad: 'low',
            },
            previous: null,
        });
        const second = countHeartbeat(first, await heartbeat({ agents: 4, update: 'available' }), NOON + 60_000);
        expect(second.current).toMatchObject({
            beats: 2,
            firstBeatAt: NOON,
            lastBeatAt: NOON + 60_000,
            agents: 4,
            setup: null,
            updateState: 'available',
        });
        expect(second.previous).toBeNull();
    });

    it('moves the day on at UTC midnight, keeping the one before only', async () => {
        const monday = countHeartbeat(undefined, await heartbeat(), NOON);
        const tuesday = countHeartbeat(monday, await heartbeat(), NOON + 24 * 60 * 60 * 1000);
        const friday = countHeartbeat(tuesday, await heartbeat(), NOON + 4 * 24 * 60 * 60 * 1000);
        expect(tuesday.previous).toEqual(monday.current);
        expect([friday.current.day, friday.current.beats, friday.previous?.day]).toEqual([
            '2027-01-19',
            1,
            '2027-01-16',
        ]);
    });
});
