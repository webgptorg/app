import type { EngineId } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type { OrgId, TeamId } from '../domain/ids';
import type { MeterDayRow, MeteringStore } from '../domain/metering/metering-store';
import { usageDaySchema } from '../domain/usage/usage-day';

const DAY = usageDaySchema.parse('2027-01-15');
const DAY_BEFORE = usageDaySchema.parse('2027-01-14');
const DAY_AFTER = usageDaySchema.parse('2027-01-16');

export interface MeteringStoreFixture {
    readonly store: MeteringStore;
    /** An organization with `people` members. */
    addOrg(people?: number): Promise<OrgId>;
    /** A team of `orgId` with the first `people` of its members. */
    addTeam(orgId: OrgId, options?: { readonly people?: number; readonly deleted?: boolean }): Promise<TeamId>;
    addEngine(
        orgId: OrgId,
        options?: { readonly teamId?: TeamId; readonly status?: 'active' | 'suspended'; readonly createdAt?: number },
    ): Promise<EngineId>;
    addEngineDay(
        orgId: OrgId,
        engineId: EngineId,
        day: typeof DAY,
        counts: { readonly agents: number; readonly members: number },
    ): Promise<void>;
}

function row(orgId: OrgId, overrides: Partial<MeterDayRow> = {}): MeterDayRow {
    return { day: DAY, orgId, scope: 'org', scopeId: orgId, meter: 'agents', value: 3, unreported: 0, ...overrides };
}

/** The {@link MeteringStore} contract, run against D1 and the in-memory store. */
export function describeMeteringStoreContract(name: string, makeFixture: () => MeteringStoreFixture): void {
    describe(`MeteringStore contract: ${name}`, () => {
        let t: MeteringStoreFixture;

        beforeEach(() => {
            t = makeFixture();
        });

        it('reads an organization without projects or teams as its people only', async () => {
            const orgId = await t.addOrg(2);
            expect(await t.store.readOrgFacts(orgId)).toEqual({ orgId, projects: [], teams: [], people: 2 });
        });

        it('reads active projects with their team and the latest heartbeat counts, oldest project first', async () => {
            const orgId = await t.addOrg(3);
            const teamId = await t.addTeam(orgId, { people: 2 });
            const reported = await t.addEngine(orgId, { teamId, createdAt: 1 });
            const silent = await t.addEngine(orgId, { createdAt: 2 });
            const revoked = await t.addEngine(orgId, { status: 'suspended', createdAt: 3 });
            await t.addEngineDay(orgId, reported, DAY_BEFORE, { agents: 9, members: 4 });
            await t.addEngineDay(orgId, reported, DAY, { agents: 5, members: 2 });
            await t.addEngineDay(orgId, revoked, DAY, { agents: 7, members: 1 });
            expect(await t.store.readOrgFacts(orgId)).toEqual({
                orgId,
                projects: [
                    { engineId: reported, teamId, heartbeat: { agents: 5, members: 2, day: DAY } },
                    { engineId: silent, teamId: null, heartbeat: null },
                ],
                teams: [{ teamId, people: 2 }],
                people: 3,
            });
        });

        it('counts live teams only, a team without people as zero', async () => {
            const orgId = await t.addOrg(1);
            const empty = await t.addTeam(orgId, { people: 0 });
            await t.addTeam(orgId, { people: 1, deleted: true });
            expect((await t.store.readOrgFacts(orgId)).teams).toEqual([{ teamId: empty, people: 0 }]);
        });

        it('reads one organization only, and lists only organizations with a project or a team', async () => {
            const withEngine = await t.addOrg(1);
            const withTeam = await t.addOrg(2);
            const empty = await t.addOrg(1);
            const onlyRevoked = await t.addOrg(1);
            const engineId = await t.addEngine(withEngine);
            const teamId = await t.addTeam(withTeam, { people: 1 });
            await t.addEngine(onlyRevoked, { status: 'suspended' });
            expect((await t.store.readOrgFacts(withTeam)).projects).toEqual([]);
            const metered = await t.store.readMeteredFacts();
            const mine = metered.filter((facts) => [withEngine, withTeam, empty, onlyRevoked].includes(facts.orgId));
            expect(mine.sort((a, b) => (a.orgId < b.orgId ? -1 : 1))).toEqual(
                [
                    {
                        orgId: withEngine,
                        projects: [{ engineId, teamId: null, heartbeat: null }],
                        teams: [],
                        people: 1,
                    },
                    { orgId: withTeam, projects: [], teams: [{ teamId, people: 1 }], people: 2 },
                ].sort((a, b) => (a.orgId < b.orgId ? -1 : 1)),
            );
        });

        it('replaces a day’s value and keeps its peak, idempotently', async () => {
            const orgId = await t.addOrg();
            await t.store.upsertMeterDays([row(orgId, { value: 3 })]);
            await t.store.upsertMeterDays([row(orgId, { value: 7, unreported: 1 })]);
            await t.store.upsertMeterDays([row(orgId, { value: 4 })]);
            await t.store.upsertMeterDays([row(orgId, { value: 4 })]);
            await t.store.upsertMeterDays([]);
            expect(await t.store.listMeterDays(orgId, DAY)).toEqual([{ ...row(orgId, { value: 4 }), peak: 7 }]);
        });

        it('writes many rows at once and lists them by day, meter, scope and scope ID', async () => {
            const orgId = await t.addOrg();
            const other = await t.addOrg();
            const rows = Array.from({ length: 30 }, (_, index) =>
                row(orgId, { scope: 'project', scopeId: `engine-${String(index).padStart(2, '0')}`, value: index }),
            );
            await t.store.upsertMeterDays([
                ...rows,
                row(orgId, { day: DAY_AFTER, meter: 'projects' }),
                row(orgId, { meter: 'projects' }),
                row(orgId, { day: DAY_BEFORE }),
                row(other),
            ]);
            const listed = await t.store.listMeterDays(orgId, DAY);
            expect(listed.map((stored) => `${stored.day} ${stored.meter} ${stored.scope} ${stored.scopeId}`)).toEqual([
                ...rows.map((stored) => `${DAY} agents project ${stored.scopeId}`),
                `${DAY} projects org ${orgId}`,
                `${DAY_AFTER} projects org ${orgId}`,
            ]);
        });

        it('prunes days before the cutoff', async () => {
            const orgId = await t.addOrg();
            await t.store.upsertMeterDays([row(orgId, { day: DAY_BEFORE }), row(orgId)]);
            await t.store.pruneMeterDays(DAY);
            expect((await t.store.listMeterDays(orgId, DAY_BEFORE)).map((stored) => stored.day)).toEqual([DAY]);
        });
    });
}
