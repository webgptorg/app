import { EngineId } from '@ptbk/protocol';
import { and, count, eq, gt, lte, sql } from 'drizzle-orm';

import type { RelayPresenceStore } from '../../domain/presence/relay-presence-store';
import type { Database } from './client';
import { relayPresence, relayPresenceReports } from './schema';

/**
 * The engine IDs travel as one JSON parameter through `json_each`, so a report of any size is a fixed number of
 * statements within D1's 100-parameter limit, and an unchanged list writes only the relay's report time.
 */
export function createD1RelayPresenceStore(db: Database): RelayPresenceStore {
    return {
        async replace(relayId, engineIds, reportedAt, expiredAt) {
            const listed = JSON.stringify(engineIds);
            // One batch (a transaction), so a reader never sees half a list. The report row comes first: rows reference
            // it, and expired relays' rows go with theirs (ON DELETE CASCADE).
            await db.batch([
                db
                    .insert(relayPresenceReports)
                    .values({ relayId, reportedAt })
                    .onConflictDoUpdate({ target: relayPresenceReports.relayId, set: { reportedAt } }),
                db.delete(relayPresenceReports).where(lte(relayPresenceReports.reportedAt, expiredAt)),
                db
                    .delete(relayPresence)
                    .where(
                        and(
                            eq(relayPresence.relayId, relayId),
                            sql`${relayPresence.engineId} not in (select value from json_each(${listed}))`,
                        ),
                    ),
                db
                    .insert(relayPresence)
                    // `where true` keeps SQLite from reading the upsert's ON as a join constraint.
                    .select(sql`select ${relayId}, value from json_each(${listed}) where true`)
                    .onConflictDoNothing(),
            ]);
        },

        async reachableRelays(engineIds, liveAfter) {
            const live = gt(relayPresenceReports.reportedAt, liveAfter);
            const [anyLive, rows] = await db.batch([
                db.select({ relayId: relayPresenceReports.relayId }).from(relayPresenceReports).where(live).limit(1),
                db
                    .select({ engineId: relayPresence.engineId, relays: count() })
                    .from(relayPresence)
                    .innerJoin(relayPresenceReports, eq(relayPresenceReports.relayId, relayPresence.relayId))
                    .where(
                        and(
                            live,
                            sql`${relayPresence.engineId} in (select value from json_each(${JSON.stringify(engineIds)}))`,
                        ),
                    )
                    .groupBy(relayPresence.engineId),
            ]);
            if (anyLive.length === 0) {
                return null;
            }
            return new Map(rows.map((row) => [EngineId.parse(row.engineId), row.relays]));
        },
    };
}
