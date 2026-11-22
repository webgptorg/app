import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';

import { licenseSnapshotSchema } from '../../domain/licensing/license-contract';
import type { Clock } from '../../domain/ports/clock';
import type { WebsiteLicensingStore } from '../../domain/licensing/website-licensing-store';
import type { Database } from './client';
import {
    orgAuditLog,
    users,
    websiteHandoffStates,
    websiteLicenseSnapshots,
    websiteLinks,
    websitePendingLinks,
} from './schema';

const dialect = new SQLiteSyncDialect();

/** `websiteOrigin` re-validates stored snapshots, so a changed origin never shows an old manage link. */
export function createD1WebsiteLicensingStore(
    db: Database,
    deps: { readonly websiteOrigin: string; readonly clock: Clock },
): WebsiteLicensingStore {
    const snapshotSchema = licenseSnapshotSchema(deps.websiteOrigin);

    return {
        async createState(state) {
            await db.batch([
                db.delete(websiteHandoffStates).where(lte(websiteHandoffStates.expiresAt, state.createdAt)),
                db.insert(websiteHandoffStates).values(state),
            ]);
        },

        async consumeState(challengeHash, now) {
            const row = await db
                .delete(websiteHandoffStates)
                .where(eq(websiteHandoffStates.challengeHash, challengeHash))
                .returning({ expiresAt: websiteHandoffStates.expiresAt })
                .get();
            return row !== undefined && row.expiresAt > now;
        },

        async createPending(pending) {
            await db.batch([
                db.delete(websitePendingLinks).where(lte(websitePendingLinks.expiresAt, pending.createdAt)),
                db.insert(websitePendingLinks).values(pending),
            ]);
        },

        async findPending(tokenHash, now) {
            const row = await db
                .select()
                .from(websitePendingLinks)
                .where(and(eq(websitePendingLinks.tokenHash, tokenHash), gt(websitePendingLinks.expiresAt, now)))
                .get();
            return row ?? null;
        },

        async deletePending(tokenHash) {
            await db.delete(websitePendingLinks).where(eq(websitePendingLinks.tokenHash, tokenHash));
        },

        async link(input) {
            // One transaction: the insert does nothing on either uniqueness conflict, and the audit entry is written only
            // if this very insert landed, so an identical binding is kept without a second entry. Raw statements, as
            // drizzle's own batch cannot carry INSERT … SELECT.
            const statements = [
                sql`INSERT INTO ${websiteLinks} (org_id, subject, linked_by_user_id, linked_at)
                    VALUES (${input.orgId}, ${input.subject}, ${input.actorId}, ${input.at}) ON CONFLICT DO NOTHING`,
                sql`INSERT INTO ${orgAuditLog} (id, org_id, actor_user_id, action, target_type, target_id, created_at)
                    SELECT ${input.auditId}, org_id, linked_by_user_id, 'website.link', 'website-account', subject, linked_at
                    FROM ${websiteLinks}
                    WHERE org_id = ${input.orgId} AND subject = ${input.subject}
                        AND linked_by_user_id = ${input.actorId} AND linked_at = ${input.at}`,
                sql`SELECT subject FROM ${websiteLinks} WHERE org_id = ${input.orgId}`,
            ].map((statement) => {
                const query = dialect.sqlToQuery(statement);
                return db.$client.prepare(query.sql).bind(...query.params);
            });
            const results = await db.$client.batch<{ readonly subject: string }>(statements);
            return results[2]?.results[0]?.subject === input.subject ? 'linked' : 'conflict';
        },

        async linkForOrg(orgId) {
            const row = await db
                .select({ subject: websiteLinks.subject, linkedAt: websiteLinks.linkedAt, email: users.email })
                .from(websiteLinks)
                .leftJoin(users, eq(users.id, websiteLinks.linkedByUserId))
                .where(eq(websiteLinks.orgId, orgId))
                .get();
            return row === undefined
                ? null
                : { subject: row.subject, linkedAt: row.linkedAt, linkedByEmail: row.email };
        },

        async subjectForOrg(orgId) {
            const row = await db
                .select({ subject: websiteLinks.subject })
                .from(websiteLinks)
                .where(eq(websiteLinks.orgId, orgId))
                .get();
            return row?.subject ?? null;
        },

        async readSnapshot(orgId) {
            const row = await db
                .select({ snapshot: websiteLicenseSnapshots.snapshot })
                .from(websiteLicenseSnapshots)
                .where(eq(websiteLicenseSnapshots.orgId, orgId))
                .get();
            if (row === undefined) {
                return null;
            }
            try {
                const parsed = snapshotSchema.safeParse(JSON.parse(row.snapshot));
                return parsed.success ? parsed.data : null;
            } catch {
                return null;
            }
        },

        async saveSnapshot(orgId, snapshot) {
            const values = {
                subject: snapshot.subject,
                snapshot: JSON.stringify(snapshot),
                fetchedAt: deps.clock.nowMs(),
            };
            await db
                .insert(websiteLicenseSnapshots)
                .values({ orgId, ...values })
                .onConflictDoUpdate({ target: websiteLicenseSnapshots.orgId, set: values });
        },
    };
}
