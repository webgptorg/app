import { EngineId } from '@ptbk/protocol';
import { and, eq, gte, lt, sql } from 'drizzle-orm';

import { orgIdSchema } from '../../domain/ids';
import { dayStartMs, nextDay, type UsageDay } from '../../domain/usage/usage-day';
import type { UsageStore } from '../../domain/usage/usage-store';
import type { Database } from './client';
import { engines, sessions, usageDailyEngines, usageDailyPeople, usageEvents } from './schema';

/** Rows per INSERT under D1's 100 bound parameters: 7 columns an event, 12 an engine day. */
const EVENTS_PER_INSERT = 14;
const ENGINE_DAYS_PER_INSERT = 8;

function chunks<T>(rows: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let index = 0; index < rows.length; index += size) {
        out.push(rows.slice(index, index + size));
    }
    return out;
}

export function createD1UsageStore(db: Database): UsageStore {
    return {
        async insertEvents(rows) {
            const [first, ...rest] = chunks(rows, EVENTS_PER_INSERT).map((chunk) =>
                db
                    .insert(usageEvents)
                    .values(chunk.map((row) => ({ ...row })))
                    .onConflictDoNothing(),
            );
            if (first !== undefined) {
                await db.batch([first, ...rest]);
            }
        },

        async listActiveEngines() {
            const rows = await db
                .select({ engineId: engines.engineId, orgId: engines.orgId })
                .from(engines)
                .where(eq(engines.status, 'active'))
                .all();
            return rows.map((row) => ({ engineId: EngineId.parse(row.engineId), orgId: orgIdSchema.parse(row.orgId) }));
        },

        async upsertEngineDays(rows) {
            const [first, ...rest] = chunks(rows, ENGINE_DAYS_PER_INSERT).map((chunk) =>
                db
                    .insert(usageDailyEngines)
                    .values(chunk.map((row) => ({ ...row })))
                    .onConflictDoUpdate({
                        target: [usageDailyEngines.day, usageDailyEngines.engineId],
                        set: {
                            orgId: sql`excluded.org_id`,
                            beats: sql`excluded.beats`,
                            firstBeatAt: sql`excluded.first_beat_at`,
                            lastBeatAt: sql`excluded.last_beat_at`,
                            engineVersion: sql`excluded.engine_version`,
                            agents: sql`excluded.agents`,
                            members: sql`excluded.members`,
                            setup: sql`excluded.setup`,
                            updateState: sql`excluded.update_state`,
                            cpuLoad: sql`excluded.cpu_load`,
                        },
                    }),
            );
            if (first !== undefined) {
                await db.batch([first, ...rest]);
            }
        },

        async rollUpPeople(day: UsageDay) {
            const from = dayStartMs(day);
            const to = dayStartMs(nextDay(day));
            await db
                .insert(usageDailyPeople)
                .select(
                    db
                        .selectDistinct({
                            day: sql<string>`${day}`.as('day'),
                            orgId: sessions.activeOrgId,
                            userId: sessions.userId,
                        })
                        .from(sessions)
                        .where(and(gte(sessions.lastSeenAt, from), lt(sessions.lastSeenAt, to))),
                )
                .onConflictDoNothing();
        },

        async prune({ eventsBefore, daysBefore }) {
            await db.batch([
                db.delete(usageEvents).where(lt(usageEvents.occurredAt, eventsBefore)),
                db.delete(usageDailyEngines).where(lt(usageDailyEngines.day, daysBefore)),
                db.delete(usageDailyPeople).where(lt(usageDailyPeople.day, daysBefore)),
            ]);
        },
    };
}
