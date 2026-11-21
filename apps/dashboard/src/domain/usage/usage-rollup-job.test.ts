import type { EngineId } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { testOrgId } from '../../testing/billing-fixtures';
import { createMemoryUsageStore } from '../../testing/memory-usage-store';
import { presenceEngineIds } from '../../testing/relay-presence-store-contract';
import { createTestUsage } from '../../testing/test-usage';
import { userIdSchema } from '../ids';
import type { EngineActivity, EngineDay } from './engine-activity';
import { usageDaySchema } from './usage-day';
import { runUsageRollup } from './usage-rollup-job';

const TUESDAY_0005 = Date.UTC(2027, 0, 19, 0, 5);

function day(name: string, beats: number): EngineDay {
    return {
        day: usageDaySchema.parse(name),
        beats,
        firstBeatAt: 1,
        lastBeatAt: 2,
        engineVersion: '1.4.2' as EngineDay['engineVersion'],
        agents: 1,
        members: 1,
        setup: 'done',
        updateState: 'none',
        cpuLoad: 'low',
    };
}

function setup(activity: (engineId: EngineId) => Promise<EngineActivity | null>) {
    const orgId = testOrgId();
    const [a, b, c] = presenceEngineIds(3) as [EngineId, EngineId, EngineId];
    const userId = userIdSchema.parse('uuuuuuuuuuuuuuuuuuuuuuuuuu');
    const sessions = [{ userId, activeOrgId: orgId, lastSeenAt: Date.UTC(2027, 0, 18, 23, 50) }];
    const store = createMemoryUsageStore({
        engines: () => [a, b, c].map((engineId) => ({ engineId, orgId })),
        sessions: () => sessions,
    });
    const { logger } = createTestUsage();
    const deps = { store, engineStatus: { getActivity: activity }, concurrency: 2, logger };
    return { deps, store, logger, orgId, userId, engines: [a, b, c] as const };
}

describe('usage rollup', () => {
    it('writes today’s and yesterday’s rows of every engine and person, and the same again on a rerun', async () => {
        const activities = new Map<string, EngineActivity>();
        const t = setup((engineId) => Promise.resolve(activities.get(engineId) ?? null));
        const [a, b] = t.engines;
        activities.set(a, { current: day('2027-01-19', 5), previous: day('2027-01-18', 1440) });
        // Its last day is long gone: nothing to write.
        activities.set(b, { current: day('2027-01-10', 7), previous: day('2027-01-09', 3) });
        await runUsageRollup(t.deps, TUESDAY_0005, new AbortController().signal);
        const once = structuredClone([...t.store.state.engineDays.entries()]);
        expect(once.map(([key, row]) => [key, row.beats, row.orgId])).toEqual([
            [`2027-01-19|${a}`, 5, t.orgId],
            [`2027-01-18|${a}`, 1440, t.orgId],
        ]);
        expect([...t.store.state.people]).toEqual([`2027-01-18|${t.orgId}|${t.userId}`]);

        await runUsageRollup(t.deps, TUESDAY_0005 + 15 * 60 * 1000, new AbortController().signal);
        expect([...t.store.state.engineDays.entries()]).toEqual(once);
        expect(t.store.state.people.size).toBe(1);
        expect(t.logger.entries).toContainEqual({
            level: 'info',
            event: 'usage.rolled-up',
            fields: { engines: 3, engineDays: 2, unanswered: 0 },
        });
    });

    it('skips an engine whose object fails to answer, and still writes the others', async () => {
        const t = setup((engineId) =>
            engineId === t.engines[0]
                ? Promise.reject(new Error('object overloaded'))
                : Promise.resolve({ current: day('2027-01-19', 1), previous: null }),
        );
        await runUsageRollup(t.deps, TUESDAY_0005, new AbortController().signal);
        expect(t.store.state.engineDays.size).toBe(2);
        expect(t.logger.entries.at(-1)?.fields).toMatchObject({ unanswered: 1 });
    });

    it('stops without writing once its time is up', async () => {
        const controller = new AbortController();
        controller.abort();
        const t = setup(() => Promise.resolve({ current: day('2027-01-19', 1), previous: null }));
        await expect(runUsageRollup(t.deps, TUESDAY_0005, controller.signal)).rejects.toThrow();
        expect(t.store.state.engineDays.size).toBe(0);
    });

    it('prunes events past 13 months and rollups past 25', async () => {
        const t = setup(() => Promise.resolve(null));
        const event = (occurredAt: number) => ({
            id: `event${String(occurredAt)}`,
            occurredAt,
            event: 'org.created' as const,
            orgId: t.orgId,
            userId: null,
            engineId: null,
            props: '{"kind":"personal"}',
        });
        await t.store.insertEvents([event(Date.UTC(2025, 11, 19, 0, 4)), event(Date.UTC(2025, 11, 19, 0, 5))]);
        const [a] = t.engines;
        await t.store.upsertEngineDays([
            { ...day('2024-12-18', 1), engineId: a, orgId: t.orgId },
            { ...day('2024-12-19', 1), engineId: a, orgId: t.orgId },
        ]);
        await runUsageRollup(t.deps, TUESDAY_0005, new AbortController().signal);
        expect(t.store.state.events.map((row) => row.occurredAt)).toEqual([Date.UTC(2025, 11, 19, 0, 5)]);
        expect([...t.store.state.engineDays.values()].map((row) => row.day)).toEqual(['2024-12-19']);
    });
});
