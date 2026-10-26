import { EngineId, Hostname } from '@ptbk/protocol';
import { and, asc, count, eq, gte, lt, notExists, sql } from 'drizzle-orm';

import type { ActiveEngineDirectory } from '../../domain/abuse/abuse-feed';
import type { PublicFaceStore } from '../../domain/abuse/public-face-store';
import type { Database } from './client';
import { engines, publicFaceChecks } from './schema';

/** Four parameters per row, under D1's 100 per statement. */
const ROWS_PER_INSERT = 24;

/** `public_face_checks` on D1, with the engines it reads to choose whom to visit. */
export function createD1PublicFaceStore(db: Database): PublicFaceStore {
    const lastCheck = sql<
        number | null
    >`(SELECT MAX(${publicFaceChecks.checkedAt}) FROM ${publicFaceChecks} WHERE ${publicFaceChecks.engineId} = ${engines.engineId})`;
    return {
        async due(limit) {
            // SQLite sorts NULL first: engines never checked come before every other.
            const rows = await db
                .select({ engineId: engines.engineId, hostname: engines.hostname })
                .from(engines)
                .where(eq(engines.status, 'active'))
                .orderBy(asc(lastCheck), asc(engines.engineId))
                .limit(limit)
                .all();
            return rows.map((row) => ({
                engineId: EngineId.parse(row.engineId),
                hostname: Hostname.parse(row.hostname),
            }));
        },

        async record(checks) {
            for (let index = 0; index < checks.length; index += ROWS_PER_INSERT) {
                await db
                    .insert(publicFaceChecks)
                    .values(checks.slice(index, index + ROWS_PER_INSERT).map((check) => ({ ...check })))
                    .onConflictDoNothing();
            }
        },

        async countUncheckedSince(since) {
            const row = await db
                .select({ total: count() })
                .from(engines)
                .where(
                    and(
                        eq(engines.status, 'active'),
                        notExists(
                            db
                                .select({ one: sql`1` })
                                .from(publicFaceChecks)
                                .where(
                                    and(
                                        eq(publicFaceChecks.engineId, engines.engineId),
                                        gte(publicFaceChecks.checkedAt, since),
                                    ),
                                ),
                        ),
                    ),
                )
                .get();
            return row?.total ?? 0;
        },

        async prune(before) {
            await db.delete(publicFaceChecks).where(lt(publicFaceChecks.checkedAt, before));
        },
    };
}

/** Active engines' default hostnames, for the abuse feeds. */
export function createD1ActiveEngineDirectory(db: Database): ActiveEngineDirectory {
    return {
        async list(limit) {
            const rows = await db
                .select({ engineId: engines.engineId, hostname: engines.hostname })
                .from(engines)
                .where(eq(engines.status, 'active'))
                .orderBy(asc(engines.engineId))
                .limit(limit)
                .all();
            return rows.map((row) => ({
                engineId: EngineId.parse(row.engineId),
                hostname: Hostname.parse(row.hostname),
            }));
        },
    };
}
