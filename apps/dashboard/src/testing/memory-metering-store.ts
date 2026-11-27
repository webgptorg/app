import type { EngineId } from '@ptbk/protocol';

import type { OrgId, TeamId } from '../domain/ids';
import type { MeterDayRow, MeteringStore, StoredMeterDay } from '../domain/metering/metering-store';
import type { HeartbeatCounts, OrgUsageFacts, ProjectFacts, TeamFacts } from '../domain/metering/usage-facts';

export interface MeteringSources {
    readonly engines: () => Iterable<{
        readonly engineId: EngineId;
        readonly orgId: OrgId;
        readonly status: 'active' | 'suspended';
        readonly createdAt: number;
        readonly teamId: TeamId | null;
    }>;
    readonly teams: () => Iterable<{
        readonly id: TeamId;
        readonly orgId: OrgId;
        readonly createdAt: number;
        readonly deletedAt: number | null;
    }>;
    readonly teamMembers: () => Iterable<{ readonly teamId: TeamId }>;
    readonly memberships: () => Iterable<{ readonly orgId: OrgId }>;
    /** Every engine day the rollup wrote. */
    readonly engineDays: () => Iterable<HeartbeatCounts & { readonly engineId: EngineId }>;
}

/** SQLite's default BINARY collation, so the memory store sorts as D1 does. */
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface MemoryMeteringStore extends MeteringStore {
    /** By `day|orgId|scope|scopeId|meter`. */
    readonly days: Map<string, StoredMeterDay>;
}

/** The D1 store's rules over whatever state the test keeps engines, teams and people in. */
export function createMemoryMeteringStore(sources: MeteringSources): MemoryMeteringStore {
    const days = new Map<string, StoredMeterDay>();

    function readFacts(orgId: OrgId | null): OrgUsageFacts[] {
        const latest = new Map<EngineId, HeartbeatCounts>();
        for (const { engineId, ...counts } of sources.engineDays()) {
            const seen = latest.get(engineId);
            if (seen === undefined || seen.day < counts.day) {
                latest.set(engineId, counts);
            }
        }
        const people = new Map<TeamId, number>();
        for (const { teamId } of sources.teamMembers()) {
            people.set(teamId, (people.get(teamId) ?? 0) + 1);
        }
        const orgs = new Map<OrgId, { projects: ProjectFacts[]; teams: TeamFacts[] }>();
        const of = (id: OrgId) => {
            let facts = orgs.get(id);
            if (facts === undefined) {
                facts = { projects: [], teams: [] };
                orgs.set(id, facts);
            }
            return facts;
        };
        if (orgId !== null) {
            of(orgId);
        }
        const inScope = (id: OrgId) => orgId === null || id === orgId;
        const engines = [...sources.engines()]
            .filter((engine) => engine.status === 'active' && inScope(engine.orgId))
            .sort((a, b) => a.createdAt - b.createdAt || byCode(a.engineId, b.engineId));
        for (const engine of engines) {
            of(engine.orgId).projects.push({
                engineId: engine.engineId,
                teamId: engine.teamId,
                heartbeat: latest.get(engine.engineId) ?? null,
            });
        }
        const teams = [...sources.teams()]
            .filter((team) => team.deletedAt === null && inScope(team.orgId))
            .sort((a, b) => a.createdAt - b.createdAt || byCode(a.id, b.id));
        for (const team of teams) {
            of(team.orgId).teams.push({ teamId: team.id, people: people.get(team.id) ?? 0 });
        }
        const members = new Map<OrgId, number>();
        for (const membership of sources.memberships()) {
            members.set(membership.orgId, (members.get(membership.orgId) ?? 0) + 1);
        }
        return [...orgs].map(([id, facts]) => ({ orgId: id, ...facts, people: members.get(id) ?? 0 }));
    }

    const key = (row: MeterDayRow) => `${row.day}|${row.orgId}|${row.scope}|${row.scopeId}|${row.meter}`;

    return {
        days,
        readOrgFacts: (orgId) => Promise.resolve(readFacts(orgId)[0] as OrgUsageFacts),
        readMeteredFacts: () => Promise.resolve(readFacts(null)),
        upsertMeterDays(rows) {
            for (const row of rows) {
                const peak = Math.max(days.get(key(row))?.peak ?? row.value, row.value);
                days.set(key(row), { ...row, peak });
            }
            return Promise.resolve();
        },
        listMeterDays(orgId, from) {
            const rows = [...days.values()].filter((row) => row.orgId === orgId && row.day >= from);
            const order = (row: StoredMeterDay) => [row.day, row.meter, row.scope, row.scopeId];
            return Promise.resolve(
                rows.sort((a, b) => {
                    const [x, y] = [order(a), order(b)];
                    const index = x.findIndex((part, i) => part !== y[i]);
                    return index === -1 ? 0 : byCode(x[index] as string, y[index] as string);
                }),
            );
        },
        pruneMeterDays(before) {
            for (const [rowKey, row] of days) {
                if (row.day < before) {
                    days.delete(rowKey);
                }
            }
            return Promise.resolve();
        },
    };
}
