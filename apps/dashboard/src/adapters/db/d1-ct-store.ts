import { and, count, eq, gte, inArray, like, lt } from 'drizzle-orm';
import { z } from 'zod';

import { CT_SOURCES } from '../../domain/abuse/ct-log-source';
import type { CtStore } from '../../domain/abuse/ct-store';
import type { Database } from './client';
import { ctCerts, ctCursors, engines } from './schema';

/** D1 binds at most 100 parameters per statement. */
const CHUNK = 90;

function chunks<T>(items: readonly T[]): T[][] {
    const out: T[][] = [];
    for (let index = 0; index < items.length; index += CHUNK) out.push(items.slice(index, index + CHUNK));
    return out;
}

const sourceSchema = z.enum(CT_SOURCES);

/** `ct_certs` and `ct_cursors` on D1; the engines' hostnames are read, never written. */
export function createD1CtStore(db: Database): CtStore {
    return {
        async cursor(source) {
            const row = await db.select().from(ctCursors).where(eq(ctCursors.source, source)).get();
            return row?.cursor ?? null;
        },

        async saveCursor(source, cursor) {
            await db
                .insert(ctCursors)
                .values({ source: sourceSchema.parse(source), cursor })
                .onConflictDoUpdate({ target: ctCursors.source, set: { cursor } });
        },

        async known(keys) {
            const found = new Set<string>();
            for (const part of chunks(keys)) {
                const rows = await db
                    .select({ key: ctCerts.issuanceSha256 })
                    .from(ctCerts)
                    .where(inArray(ctCerts.issuanceSha256, part))
                    .all();
                for (const row of rows) found.add(row.key);
            }
            return found;
        },

        async insert(records) {
            // Seven parameters per row.
            for (let index = 0; index < records.length; index += 14) {
                await db
                    .insert(ctCerts)
                    .values(
                        records.slice(index, index + 14).map((record) => ({
                            issuanceSha256: record.issuanceSha256,
                            source: record.source,
                            firstSeenAt: record.firstSeenAt,
                            notBefore: record.notBefore,
                            hostnames: JSON.stringify(record.hostnames),
                            issuer: record.issuer,
                            alert: record.alert.length === 0 ? null : record.alert.join(','),
                        })),
                    )
                    .onConflictDoNothing();
            }
        },

        async registeredHostnames(hostnames) {
            const found = new Set<string>();
            for (const part of chunks(hostnames)) {
                const rows = await db
                    .select({ hostname: engines.hostname })
                    .from(engines)
                    .where(inArray(engines.hostname, part))
                    .all();
                for (const row of rows) found.add(row.hostname);
            }
            return found;
        },

        async countIssuedSince(hostname, since) {
            // An engine's default hostname is base32 and the engine domain, so it holds no LIKE wildcard; the quotes
            // match one whole element of the JSON array.
            const row = await db
                .select({ total: count() })
                .from(ctCerts)
                .where(and(gte(ctCerts.notBefore, since), like(ctCerts.hostnames, `%${JSON.stringify(hostname)}%`)))
                .get();
            return row?.total ?? 0;
        },

        async prune(before) {
            await db.delete(ctCerts).where(lt(ctCerts.firstSeenAt, before));
        },
    };
}
