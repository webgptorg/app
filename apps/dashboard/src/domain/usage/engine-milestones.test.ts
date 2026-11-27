import { describe, expect, it } from 'vitest';

import { createTestEngine } from '../../testing/test-engine';
import { testOrgId } from '../../testing/billing-fixtures';
import type { HeartbeatPayload, StoredEngineStatus, TrackedEngineStatus } from '../status/engine-status';
import { heartbeatMilestones } from './engine-milestones';

const AT = 1_800_000_000_000;

async function tracked(setup: HeartbeatPayload['setup']): Promise<TrackedEngineStatus> {
    const engine = await createTestEngine();
    return {
        kind: 'tracked',
        engineId: engine.engineId,
        orgId: testOrgId(),
        state: 'online',
        lastSeenAt: AT,
        lastSeq: 1,
        payload: {
            ts: new Date(AT).toISOString() as HeartbeatPayload['ts'],
            receivedAt: AT,
            version: '1.4.2' as HeartbeatPayload['version'],
            uptimeS: 1,
            diskPct: 40,
            ramPct: 70,
            cpuLoad: 'low',
            update: 'none',
            agents: 0,
            members: 0,
            ...(setup === undefined ? {} : { setup }),
        },
        offlineSince: null,
        alert: { kind: 'none' },
        notice: { kind: 'none' },
    };
}

const names = (stored: StoredEngineStatus | null, accepted: TrackedEngineStatus) =>
    heartbeatMilestones(stored, accepted).map((event) => [event.event, event.props]);

describe('heartbeat milestones', () => {
    it('marks an engine’s first heartbeat with the setup state it reported', async () => {
        expect(names(null, await tracked('pending'))).toEqual([['engine.first_heartbeat', { setup: 'pending' }]]);
        expect(names(null, await tracked(undefined))).toEqual([['engine.first_heartbeat', { setup: 'unreported' }]]);
        expect(names(null, await tracked('done'))).toEqual([
            ['engine.first_heartbeat', { setup: 'done' }],
            ['engine.setup_completed', {}],
        ]);
    });

    it('marks setup completed only when it goes from pending to done', async () => {
        expect(names(await tracked('pending'), await tracked('done'))).toEqual([['engine.setup_completed', {}]]);
        expect(names(await tracked('done'), await tracked('done'))).toEqual([]);
        expect(names(await tracked(undefined), await tracked('done'))).toEqual([]);
        expect(names(await tracked('pending'), await tracked('pending'))).toEqual([]);
    });

    it('does not count a purged engine’s return as a first heartbeat', async () => {
        const purged: StoredEngineStatus = { kind: 'purged', state: 'offline', lastSeenAt: AT };
        expect(names(purged, await tracked('done'))).toEqual([]);
    });

    it('names the engine and its organization, and no person', async () => {
        const accepted = await tracked('pending');
        expect(heartbeatMilestones(null, accepted)[0]).toMatchObject({
            orgId: accepted.orgId,
            engineId: accepted.engineId,
            userId: null,
        });
    });
});
