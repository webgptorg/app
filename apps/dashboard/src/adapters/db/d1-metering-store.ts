import { EngineId } from '@ptbk/protocol';
import { and, asc, count, eq, gte, isNull, lt, sql, type SQL } from 'drizzle-orm';

import { orgIdSchema, teamIdSchema, type OrgId } from '../../domain/ids';
import type { MeteringStore } from '../../domain/metering/metering-store';
import type { OrgUsageFacts, ProjectFacts, TeamFacts } from '../../domain/metering/usage-facts';
import { usageDaySchema } from '../../domain/usage/usage-day';
import { meterIdSchema, meterScopeSchema } from '../../shared/metering';
import type { Database } from './client';
import { engines, memberships, teamMembers, teams, usageDailyEngines, usageDailyMeters } from './schema';

/** Rows per INSERT under D1's 100 bound parameters: 8 columns a row. */
const METER_DAYS_PER_INSERT = 12;

function chunks<T>(rows: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let index = 0; index < rows.length; index += size) {
        out.push(rows.slice(index, index + size));
    }
    return out;
}

export function createD1MeteringStore(db: Database): MeteringStore {
    async function readFacts(orgId: OrgId | null): Promise<OrgUsageFacts[]> {
        const orgFilter = (column: Parameters<typeof eq>[0]): SQL | undefined =>
            orgId === null ? undefined : eq(column, orgId);
        const [projectRows, teamRows, peopleRows] = await db.batch([
            db
                .select({
                    engineId: engines.engineId,
                    orgId: engines.orgId,
                    teamId: engines.teamId,
                    agents: usageDailyEngines.agents,
                    members: usageDailyEngines.members,
                    day: usageDailyEngines.day,
                })
                .from(engines)
                .leftJoin(
                    usageDailyEngines,
                    and(
                        eq(usageDailyEngines.engineId, engines.engineId),
                        eq(
                            usageDailyEngines.day,
                            sql`(SELECT max(latest.day) FROM ${usageDailyEngines} AS latest WHERE latest.engine_id = ${engines.engineId})`,
                        ),
                    ),
                )
                .where(and(eq(engines.status, 'active'), orgFilter(engines.orgId)))
                .orderBy(asc(engines.createdAt), asc(engines.engineId)),
            db
                .select({ teamId: teams.id, orgId: teams.orgId, people: count(teamMembers.userId) })
                .from(teams)
                .leftJoin(teamMembers, eq(teamMembers.teamId, teams.id))
                .where(and(isNull(teams.deletedAt), orgFilter(teams.orgId)))
                .groupBy(teams.id)
                .orderBy(asc(teams.createdAt), asc(teams.id)),
            db
                .select({ orgId: memberships.orgId, people: count() })
                .from(memberships)
                .where(orgFilter(memberships.orgId))
                .groupBy(memberships.orgId),
        ]);

        const orgs = new Map<string, { projects: ProjectFacts[]; teams: TeamFacts[] }>();
        const of = (id: string) => {
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
        for (const row of projectRows) {
            of(row.orgId).projects.push({
                engineId: EngineId.parse(row.engineId),
                teamId: row.teamId === null ? null : teamIdSchema.parse(row.teamId),
                heartbeat:
                    row.day === null || row.agents === null || row.members === null
                        ? null
                        : { agents: row.agents, members: row.members, day: usageDaySchema.parse(row.day) },
            });
        }
        for (const row of teamRows) {
            of(row.orgId).teams.push({ teamId: teamIdSchema.parse(row.teamId), people: row.people });
        }
        const people = new Map(peopleRows.map((row) => [row.orgId, row.people]));
        return [...orgs].map(([id, facts]) => ({
            orgId: orgIdSchema.parse(id),
            ...facts,
            people: people.get(id) ?? 0,
        }));
    }

    return {
        async readOrgFacts(orgId) {
            const [facts] = await readFacts(orgId);
            return facts as OrgUsageFacts;
        },

        readMeteredFacts: () => readFacts(null),

        async upsertMeterDays(rows) {
            const [first, ...rest] = chunks(rows, METER_DAYS_PER_INSERT).map((chunk) =>
                db
                    .insert(usageDailyMeters)
                    .values(chunk.map((row) => ({ ...row, peak: row.value })))
                    .onConflictDoUpdate({
                        target: [
                            usageDailyMeters.day,
                            usageDailyMeters.orgId,
                            usageDailyMeters.scope,
                            usageDailyMeters.scopeId,
                            usageDailyMeters.meter,
                        ],
                        set: {
                            value: sql`excluded.value`,
                            unreported: sql`excluded.unreported`,
                            peak: sql`max(${usageDailyMeters.peak}, excluded.value)`,
                        },
                    }),
            );
            if (first !== undefined) {
                await db.batch([first, ...rest]);
            }
        },

        async listMeterDays(orgId, from) {
            const rows = await db
                .select()
                .from(usageDailyMeters)
                .where(and(eq(usageDailyMeters.orgId, orgId), gte(usageDailyMeters.day, from)))
                .orderBy(
                    asc(usageDailyMeters.day),
                    asc(usageDailyMeters.meter),
                    asc(usageDailyMeters.scope),
                    asc(usageDailyMeters.scopeId),
                )
                .all();
            return rows.map((row) => ({
                ...row,
                day: usageDaySchema.parse(row.day),
                orgId: orgIdSchema.parse(row.orgId),
                scope: meterScopeSchema.parse(row.scope),
                meter: meterIdSchema.parse(row.meter),
            }));
        },

        async pruneMeterDays(before) {
            await db.delete(usageDailyMeters).where(lt(usageDailyMeters.day, before));
        },
    };
}
