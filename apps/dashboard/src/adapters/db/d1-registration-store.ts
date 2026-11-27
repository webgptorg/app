import {
    Ed25519PublicKey,
    EngineId,
    EngineVersion,
    Hostname,
    OwnerSetupCommitment,
    RegistrationMode,
} from '@ptbk/protocol';
import {
    and,
    asc,
    count,
    desc,
    eq,
    exists,
    gt,
    isNotNull,
    isNull,
    lt,
    lte,
    ne,
    notExists,
    or,
    sql,
    type SQL,
} from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

import type { AdminAuditEntry } from '../../domain/auth/records';
import type { PlatformEngineStore } from '../../domain/engines/platform-engine-store';
import { linkCodeIdSchema, orgIdSchema, type OrgId } from '../../domain/ids';
import {
    OWNER_REVOKED,
    PLATFORM_SUSPENDED,
    type EngineRecord,
    type EngineStore,
} from '../../domain/registration/engine-store';
import type { LinkCodeStore } from '../../domain/registration/link-code-store';
import { engineLabelSchema } from '../../shared/engine-label';
import { LINK_CODE_LIMITS } from '../../shared/link-code-limits';
import type { Database } from './client';
import { adminAuditLog, engines, linkCodes, orgAuditLog } from './schema';

const engineStatusSchema = z.enum(['active', 'suspended']);

function toEngine(row: typeof engines.$inferSelect): EngineRecord {
    return {
        engineId: EngineId.parse(row.engineId),
        orgId: orgIdSchema.parse(row.orgId),
        publicKey: Ed25519PublicKey.parse(row.publicKey),
        hostname: Hostname.parse(row.hostname),
        mode: RegistrationMode.parse(row.mode),
        engineVersion: EngineVersion.parse(row.engineVersion),
        status: engineStatusSchema.parse(row.status),
        statusReason: row.statusReason,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        label: row.label === null ? null : engineLabelSchema.parse(row.label),
    };
}

function redeemable(codeHash: string, orgId: OrgId, now: number) {
    return and(
        eq(linkCodes.codeHash, codeHash),
        eq(linkCodes.orgId, orgId),
        isNull(linkCodes.usedAt),
        gt(linkCodes.expiresAt, now),
    );
}

/** The row the first statement of a redemption batch has just written; the second only runs on top of it. */
function redeemedBy(codeHash: string, engineId: EngineId, now: number) {
    return and(eq(linkCodes.codeHash, codeHash), eq(linkCodes.usedAt, now), eq(linkCodes.engineId, engineId));
}

/**
 * Redemption is one D1 batch (a transaction): the conditional update of the code, then the engine write conditioned
 * on that update, so a lost race changes neither table and an error rolls both back.
 */
export function createD1LinkCodeStore(db: Database): LinkCodeStore {
    const dialect = new SQLiteSyncDialect();
    const engineExists = (engineId: EngineId) =>
        db
            .select({ one: sql`1` })
            .from(engines)
            .where(eq(engines.engineId, engineId));

    return {
        async insert(record) {
            const { orgId, createdAt } = record;
            const org = eq(linkCodes.orgId, orgId);
            const active = db.$count(linkCodes, and(org, isNull(linkCodes.usedAt), gt(linkCodes.expiresAt, createdAt)));
            const recent = db.$count(
                linkCodes,
                and(org, gt(linkCodes.createdAt, createdAt - LINK_CODE_LIMITS.windowMs)),
            );
            // One transaction decides which quota refused the code and writes only when both have room.
            const statements = [
                sql`SELECT 1 WHERE ${active} >= ${LINK_CODE_LIMITS.active}`,
                sql`INSERT INTO ${linkCodes} (id, code_hash, org_id, created_by_user_id, created_at, expires_at, owner_setup_commitment)
                    SELECT ${record.id}, ${record.codeHash}, ${orgId}, ${record.createdByUserId}, ${createdAt}, ${record.expiresAt}, ${record.ownerSetupCommitment}
                    WHERE ${active} < ${LINK_CODE_LIMITS.active} AND ${recent} < ${LINK_CODE_LIMITS.perHour}`,
            ].map((statement) => {
                const query = dialect.sqlToQuery(statement);
                return db.$client.prepare(query.sql).bind(...query.params);
            });
            const [full, insertion] = await db.$client.batch(statements);
            if (full?.results.length === 1) return 'link-code-limit';
            return insertion?.meta.changes === 1 ? 'inserted' : 'rate-limited';
        },

        async listPending(orgId, now) {
            const rows = await db
                .select({ id: linkCodes.id, createdAt: linkCodes.createdAt, expiresAt: linkCodes.expiresAt })
                .from(linkCodes)
                .where(
                    and(
                        eq(linkCodes.orgId, orgId),
                        isNull(linkCodes.usedAt),
                        gt(linkCodes.expiresAt, now),
                        isNotNull(linkCodes.id),
                    ),
                )
                .orderBy(desc(linkCodes.createdAt), desc(linkCodes.id))
                .all();
            return rows.map((row) => ({
                id: linkCodeIdSchema.parse(row.id),
                createdAt: row.createdAt,
                expiresAt: row.expiresAt,
            }));
        },

        async clearExpiredCommitments(now) {
            const rows = await db
                .update(linkCodes)
                .set({ ownerSetupCommitment: null })
                .where(and(isNotNull(linkCodes.ownerSetupCommitment), lte(linkCodes.expiresAt, now)))
                .returning({ id: linkCodes.id });
            return rows.length;
        },

        async cancel(orgId, id, now) {
            const rows = await db
                .update(linkCodes)
                .set({ expiresAt: now, ownerSetupCommitment: null })
                .where(
                    and(
                        eq(linkCodes.id, id),
                        eq(linkCodes.orgId, orgId),
                        isNull(linkCodes.usedAt),
                        gt(linkCodes.expiresAt, now),
                    ),
                )
                .returning({ id: linkCodes.id });
            return rows.length === 1 ? 'cancelled' : 'not-found';
        },

        async findState(orgId, id, now) {
            const row = await db
                .select({ expiresAt: linkCodes.expiresAt, engineId: linkCodes.engineId })
                .from(linkCodes)
                .where(and(eq(linkCodes.id, id), eq(linkCodes.orgId, orgId)))
                .get();
            if (row === undefined) {
                return null;
            }
            if (row.engineId !== null) {
                return { kind: 'linked', engineId: EngineId.parse(row.engineId) };
            }
            return now < row.expiresAt ? { kind: 'pending', expiresAt: row.expiresAt } : { kind: 'expired' };
        },

        async findRedeemable(codeHash, now) {
            const row = await db
                .select({ orgId: linkCodes.orgId, ownerSetupCommitment: linkCodes.ownerSetupCommitment })
                .from(linkCodes)
                .where(and(eq(linkCodes.codeHash, codeHash), isNull(linkCodes.usedAt), gt(linkCodes.expiresAt, now)))
                .get();
            return row === undefined
                ? null
                : {
                      orgId: orgIdSchema.parse(row.orgId),
                      ownerSetupCommitment:
                          row.ownerSetupCommitment === null
                              ? null
                              : OwnerSetupCommitment.parse(row.ownerSetupCommitment),
                  };
        },

        async redeemForNewEngine(codeHash, engine, maxActiveEngines) {
            const now = engine.createdAt;
            const capacity =
                maxActiveEngines === null
                    ? undefined
                    : lt(
                          db.$count(engines, and(eq(engines.orgId, engine.orgId), eq(engines.status, 'active'))),
                          maxActiveEngines,
                      );
            const [consumed] = await db.batch([
                db
                    .update(linkCodes)
                    .set({ usedAt: now, engineId: engine.engineId, ownerSetupCommitment: null })
                    .where(
                        and(
                            redeemable(codeHash, engine.orgId, now),
                            notExists(engineExists(engine.engineId)),
                            capacity,
                        ),
                    )
                    .returning({ codeHash: linkCodes.codeHash }),
                db.insert(engines).select((qb) =>
                    qb
                        // Every column of `engines`, in table order.
                        .select({
                            engineId: sql`${engine.engineId}`.as('engine_id'),
                            orgId: linkCodes.orgId,
                            publicKey: sql`${engine.publicKey}`.as('public_key'),
                            hostname: sql`${engine.hostname}`.as('hostname'),
                            mode: sql`${engine.mode}`.as('mode'),
                            engineVersion: sql`${engine.engineVersion}`.as('engine_version'),
                            status: sql`${engine.status}`.as('status'),
                            statusReason: sql`${engine.statusReason}`.as('status_reason'),
                            createdAt: sql`${engine.createdAt}`.as('created_at'),
                            updatedAt: sql`${engine.updatedAt}`.as('updated_at'),
                            label: sql`${engine.label}`.as('label'),
                            // Bound right after, by `TeamStore.bindNewEngine`, so a lost race never fails the link.
                            teamId: sql`NULL`.as('team_id'),
                        })
                        .from(linkCodes)
                        .where(
                            and(redeemedBy(codeHash, engine.engineId, now), notExists(engineExists(engine.engineId))),
                        ),
                ),
            ]);
            return consumed.length === 1 ? 'redeemed' : 'conflict';
        },

        async redeemForExistingEngine(codeHash, refresh) {
            const active = and(
                eq(engines.engineId, refresh.engineId),
                eq(engines.orgId, refresh.orgId),
                eq(engines.status, 'active'),
            );
            const [consumed] = await db.batch([
                db
                    .update(linkCodes)
                    .set({ usedAt: refresh.now, engineId: refresh.engineId, ownerSetupCommitment: null })
                    .where(
                        and(
                            redeemable(codeHash, refresh.orgId, refresh.now),
                            exists(
                                db
                                    .select({ one: sql`1` })
                                    .from(engines)
                                    .where(active),
                            ),
                        ),
                    )
                    .returning({ codeHash: linkCodes.codeHash }),
                db
                    .update(engines)
                    .set({ mode: refresh.mode, engineVersion: refresh.engineVersion, updatedAt: refresh.now })
                    .where(
                        and(
                            active,
                            exists(
                                db
                                    .select({ one: sql`1` })
                                    .from(linkCodes)
                                    .where(redeemedBy(codeHash, refresh.engineId, refresh.now)),
                            ),
                        ),
                    ),
            ]);
            return consumed.length === 1 ? 'redeemed' : 'conflict';
        },
    };
}

const REVOKE_ACTION = 'engine.revoke';
const RENAME_ACTION = 'engine.rename';

/** Every organization-facing query filters by `org_id`; `findForRegistration` is the documented exception. */
export function createD1EngineStore(db: Database): EngineStore {
    const inOrg = (orgId: OrgId, engineId: EngineId) => and(eq(engines.engineId, engineId), eq(engines.orgId, orgId));
    const findInOrg = async (orgId: OrgId, engineId: EngineId) => {
        const row = await db.select().from(engines).where(inOrg(orgId, engineId)).get();
        return row === undefined ? null : toEngine(row);
    };

    return {
        async countActive(orgId) {
            const row = await db
                .select({ total: count() })
                .from(engines)
                .where(and(eq(engines.orgId, orgId), eq(engines.status, 'active')))
                .get();
            return row?.total ?? 0;
        },

        async listForOrg(orgId) {
            const rows = await db
                .select()
                .from(engines)
                .where(eq(engines.orgId, orgId))
                .orderBy(asc(engines.createdAt), asc(engines.engineId))
                .all();
            return rows.map(toEngine);
        },

        findInOrg,

        // One batch (a transaction): the conditional update, then the audit insert, which only runs for a revoked
        // engine that has no revocation entry yet. Revocation is permanent, so there is at most one per engine, and a
        // concurrent second revoke can neither change the row again nor log twice.
        async revoke(orgId, engineId, audit) {
            const [revoked] = await db.batch([
                db
                    .update(engines)
                    .set({ status: 'suspended', statusReason: OWNER_REVOKED, updatedAt: audit.at })
                    .where(
                        and(
                            inOrg(orgId, engineId),
                            or(
                                ne(engines.status, 'suspended'),
                                isNull(engines.statusReason),
                                ne(engines.statusReason, OWNER_REVOKED),
                            ),
                        ),
                    )
                    .returning({ engineId: engines.engineId }),
                db.insert(orgAuditLog).select((qb) =>
                    qb
                        // Every column of `org_audit_log`, in table order.
                        .select({
                            id: sql`${audit.id}`.as('id'),
                            orgId: engines.orgId,
                            actorUserId: sql`${audit.actorUserId}`.as('actor_user_id'),
                            action: sql`${REVOKE_ACTION}`.as('action'),
                            targetType: sql`'engine'`.as('target_type'),
                            targetId: engines.engineId,
                            createdAt: sql`${audit.at}`.as('created_at'),
                        })
                        .from(engines)
                        .where(
                            and(
                                inOrg(orgId, engineId),
                                eq(engines.statusReason, OWNER_REVOKED),
                                notExists(
                                    db
                                        .select({ one: sql`1` })
                                        .from(orgAuditLog)
                                        .where(
                                            and(
                                                eq(orgAuditLog.orgId, orgId),
                                                eq(orgAuditLog.action, REVOKE_ACTION),
                                                eq(orgAuditLog.targetId, engineId),
                                            ),
                                        ),
                                ),
                            ),
                        ),
                ),
            ]);
            if (revoked.length === 1) {
                return 'revoked';
            }
            return (await findInOrg(orgId, engineId)) === null ? 'not-found' : 'already-revoked';
        },

        // One batch: the audit insert, then the update, under the same condition, so an entry is written exactly when
        // the label changes. `IS NOT` compares null as a value, so clearing an unnamed engine changes nothing.
        async rename(orgId, engineId, label, audit) {
            const differs = and(inOrg(orgId, engineId), sql`${engines.label} IS NOT ${label}`);
            const [, renamed] = await db.batch([
                db.insert(orgAuditLog).select((qb) =>
                    qb
                        // Every column of `org_audit_log`, in table order.
                        .select({
                            id: sql`${audit.id}`.as('id'),
                            orgId: engines.orgId,
                            actorUserId: sql`${audit.actorUserId}`.as('actor_user_id'),
                            action: sql`${RENAME_ACTION}`.as('action'),
                            targetType: sql`'engine'`.as('target_type'),
                            targetId: engines.engineId,
                            createdAt: sql`${audit.at}`.as('created_at'),
                        })
                        .from(engines)
                        .where(differs),
                ),
                db
                    .update(engines)
                    .set({ label, updatedAt: audit.at })
                    .where(differs)
                    .returning({ engineId: engines.engineId }),
            ]);
            if (renamed.length === 1) {
                return 'renamed';
            }
            return (await findInOrg(orgId, engineId)) === null ? 'not-found' : 'unchanged';
        },

        async findForRegistration(engineId) {
            const row = await db.select().from(engines).where(eq(engines.engineId, engineId)).get();
            return row === undefined ? null : toEngine(row);
        },
    };
}

/**
 * Platform admin suspension (I-05). Each change is one `db.batch`, which D1 applies as a transaction: first the audit
 * entry, inserted only while the engine is in the state the update expects, then the update under the same
 * condition. Nothing runs between them, so an entry is written exactly when the engine changes.
 */
export function createD1PlatformEngineStore(db: Database): PlatformEngineStore {
    const find = async (engineId: EngineId) => {
        const row = await db.select().from(engines).where(eq(engines.engineId, engineId)).get();
        return row === undefined ? null : toEngine(row);
    };
    const auditWhere = (entry: AdminAuditEntry, condition: SQL | undefined) =>
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
                .from(engines)
                .where(condition),
        );

    return {
        find,

        async suspend(engineId, audit) {
            const active = and(eq(engines.engineId, engineId), eq(engines.status, 'active'));
            const [, changed] = await db.batch([
                auditWhere(audit, active),
                db
                    .update(engines)
                    .set({ status: 'suspended', statusReason: PLATFORM_SUSPENDED, updatedAt: audit.createdAt })
                    .where(active)
                    .returning({ engineId: engines.engineId }),
            ]);
            if (changed.length === 1) {
                return 'suspended';
            }
            return (await find(engineId)) === null ? 'not-found' : 'already-suspended';
        },

        async unsuspend(engineId, audit) {
            const platformSuspended = and(
                eq(engines.engineId, engineId),
                eq(engines.status, 'suspended'),
                eq(engines.statusReason, PLATFORM_SUSPENDED),
            );
            const [, changed] = await db.batch([
                auditWhere(audit, platformSuspended),
                db
                    .update(engines)
                    .set({ status: 'active', statusReason: null, updatedAt: audit.createdAt })
                    .where(platformSuspended)
                    .returning({ engineId: engines.engineId }),
            ]);
            if (changed.length === 1) {
                return 'unsuspended';
            }
            const engine = await find(engineId);
            if (engine === null) {
                return 'not-found';
            }
            return engine.status === 'suspended' && engine.statusReason === OWNER_REVOKED
                ? 'owner-revoked'
                : 'not-suspended';
        },
    };
}
