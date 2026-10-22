import { Ed25519PublicKey, Ed25519Signature, EngineId, Hostname, HostnameClaim } from '@ptbk/protocol';
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { AdminAuditEntry } from '../../domain/auth/records';
import type { CustomHostnameRecord, CustomHostnameStore } from '../../domain/custom-hostnames/custom-hostname-store';
import { orgIdSchema, userIdSchema } from '../../domain/ids';
import type { EngineHostnameStore } from '../../domain/registry/engine-hostname-store';
import type { Database } from './client';
import { isUniqueViolation } from './d1-auth-store';
import { adminAuditLog, engineHostnames, engines } from './schema';

const rowSchema = z.strictObject({
    hostname: Hostname,
    engineId: EngineId,
    orgId: orgIdSchema,
    claimSig: Ed25519Signature,
    status: z.enum(['pending-dns', 'active']),
    dnsCheckedAt: z.number().int().nullable(),
    createdAt: z.number().int(),
    createdByUserId: userIdSchema,
});

/**
 * `engine_hostnames` on D1, for the platform admin flow and for the registry. Each change and its `admin_audit_log`
 * entry are one `db.batch`, which D1 applies atomically.
 */
export function createD1CustomHostnameStore(db: Database): CustomHostnameStore & EngineHostnameStore {
    const owned = (engineId: EngineId, hostname: Hostname) =>
        and(eq(engineHostnames.hostname, hostname), eq(engineHostnames.engineId, engineId));
    /** The audit entry, written only if the row is there when the statement runs. */
    const auditIfPresent = (entry: AdminAuditEntry, engineId: EngineId, hostname: Hostname) =>
        db.insert(adminAuditLog).select((qb) =>
            qb
                // Every column of `admin_audit_log`, in table order.
                .select({
                    id: sql`${entry.id}`.as('id'),
                    adminUserId: sql`${entry.adminUserId}`.as('admin_user_id'),
                    action: sql`${entry.action}`.as('action'),
                    targetType: sql`${entry.targetType}`.as('target_type'),
                    targetId: sql`${entry.targetId}`.as('target_id'),
                    reason: sql`${entry.reason}`.as('reason'),
                    createdAt: sql`${entry.createdAt}`.as('created_at'),
                })
                .from(engineHostnames)
                .where(owned(engineId, hostname)),
        );

    return {
        async activeCustomHostnames(engineId) {
            const rows = await db
                .select({ hostname: engineHostnames.hostname, sig: engineHostnames.claimSig })
                .from(engineHostnames)
                .where(and(eq(engineHostnames.engineId, engineId), eq(engineHostnames.status, 'active')))
                .orderBy(asc(engineHostnames.createdAt), asc(engineHostnames.hostname))
                .all();
            // A row that no longer parses routes nowhere; the engine's other hostnames are unaffected.
            return rows.flatMap((row) => {
                const claim = HostnameClaim.safeParse(row);
                return claim.success ? [claim.data] : [];
            });
        },

        async findEngine(engineId) {
            const row = await db
                .select({ orgId: engines.orgId, publicKey: engines.publicKey })
                .from(engines)
                .where(eq(engines.engineId, engineId))
                .get();
            return row === undefined
                ? null
                : { orgId: orgIdSchema.parse(row.orgId), publicKey: Ed25519PublicKey.parse(row.publicKey) };
        },

        async listForEngine(engineId) {
            const rows = await db
                .select()
                .from(engineHostnames)
                .where(eq(engineHostnames.engineId, engineId))
                .orderBy(asc(engineHostnames.createdAt), asc(engineHostnames.hostname))
                .all();
            return rows.map((row): CustomHostnameRecord => rowSchema.parse(row));
        },

        async find(engineId, hostname) {
            const row = await db.select().from(engineHostnames).where(owned(engineId, hostname)).get();
            return row === undefined ? null : rowSchema.parse(row);
        },

        async isAssigned(hostname) {
            const row = await db
                .select({ one: sql`1` })
                .from(engineHostnames)
                .where(eq(engineHostnames.hostname, hostname))
                .get();
            return row !== undefined;
        },

        async insert(record, audit) {
            try {
                await db.batch([db.insert(engineHostnames).values(record), db.insert(adminAuditLog).values(audit)]);
                return 'inserted';
            } catch (error) {
                if (isUniqueViolation(error)) {
                    return 'taken';
                }
                throw error;
            }
        },

        async recordDnsCheck(engineId, hostname, check, audit) {
            const update = db
                .update(engineHostnames)
                .set({ status: check.status, dnsCheckedAt: check.checkedAt })
                .where(owned(engineId, hostname))
                .returning({ hostname: engineHostnames.hostname });
            const [updated] =
                audit === null ? [await update] : await db.batch([update, auditIfPresent(audit, engineId, hostname)]);
            return updated.length === 1 ? 'updated' : 'not-found';
        },

        async remove(engineId, hostname, audit) {
            const [, removed] = await db.batch([
                auditIfPresent(audit, engineId, hostname),
                db
                    .delete(engineHostnames)
                    .where(owned(engineId, hostname))
                    .returning({ hostname: engineHostnames.hostname }),
            ]);
            return removed.length === 1 ? 'removed' : 'not-found';
        },
    };
}
