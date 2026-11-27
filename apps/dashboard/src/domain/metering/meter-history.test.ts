import { describe, expect, it } from 'vitest';

import { testFacts } from '../../testing/test-metering';
import { createTestUsage } from '../../testing/test-usage';
import { createMemoryMeteringStore } from '../../testing/memory-metering-store';
import { usageDaySchema } from '../usage/usage-day';
import { meterDayRows, runMeterHistory } from './meter-history';
import type { MeteringStore } from './metering-store';

const NOON = Date.UTC(2027, 0, 15, 12);
const DAY = usageDaySchema.parse('2027-01-15');

describe('meter history', () => {
    it('writes every meter for the organization, each team and each project', () => {
        const { facts, engines, teams } = testFacts();
        const rows = meterDayRows(DAY, facts);
        // Four meters, each for the organization, two teams and three projects.
        expect(rows).toHaveLength(4 * 6);
        expect(rows).toContainEqual({
            day: DAY,
            orgId: facts.orgId,
            scope: 'org',
            scopeId: facts.orgId,
            meter: 'agents',
            value: 5,
            unreported: 2,
        });
        expect(rows).toContainEqual(
            expect.objectContaining({ scope: 'team', scopeId: teams.empty, meter: 'projects', value: 0 }),
        );
        expect(rows).toContainEqual(
            expect.objectContaining({ scope: 'project', scopeId: engines.silent, meter: 'members', unreported: 1 }),
        );
    });

    it('rewrites today’s rows on every run, keeps the peak and prunes past the rollups’ retention', async () => {
        const { facts } = testFacts();
        const store = createMemoryMeteringStore({
            engines: () => [],
            teams: () => [],
            teamMembers: () => [],
            memberships: () => [],
            engineDays: () => [],
        });
        let current = facts;
        const { logger } = createTestUsage();
        const deps = { store: { ...store, readMeteredFacts: () => Promise.resolve([current]) }, logger };
        await store.upsertMeterDays([
            {
                day: usageDaySchema.parse('2024-12-14'),
                orgId: facts.orgId,
                scope: 'org',
                scopeId: facts.orgId,
                meter: 'agents',
                value: 1,
                unreported: 0,
            },
        ]);
        await runMeterHistory(deps, NOON, new AbortController().signal);
        current = { ...facts, projects: facts.projects.slice(1) };
        await runMeterHistory(deps, NOON + 60_000, new AbortController().signal);
        const agents = (await store.listMeterDays(facts.orgId, usageDaySchema.parse('2000-01-01'))).filter(
            (row) => row.meter === 'agents' && row.scope === 'org',
        );
        expect(agents).toEqual([expect.objectContaining({ day: DAY, value: 0, unreported: 2, peak: 5 })]);
        expect(logger.entries.at(-1)).toMatchObject({ event: 'metering.history-written', fields: { orgs: 1 } });
    });

    it('stops without writing once its time is up', async () => {
        const writes: unknown[] = [];
        const store: Pick<MeteringStore, 'readMeteredFacts' | 'upsertMeterDays' | 'pruneMeterDays'> = {
            readMeteredFacts: () => Promise.resolve([testFacts().facts]),
            upsertMeterDays: (rows) => Promise.resolve(void writes.push(rows)),
            pruneMeterDays: () => Promise.resolve(),
        };
        const controller = new AbortController();
        controller.abort();
        await expect(
            runMeterHistory({ store, logger: createTestUsage().logger }, NOON, controller.signal),
        ).rejects.toThrow();
        expect(writes).toEqual([]);
    });
});
