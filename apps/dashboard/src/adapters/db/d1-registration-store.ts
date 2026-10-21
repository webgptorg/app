import { Ed25519PublicKey, EngineId, EngineVersion, Hostname, RegistrationMode } from '@ptbk/protocol';
import { and, count, eq, exists, gt, isNull, notExists, sql } from 'drizzle-orm';
import { z } from 'zod';

import { orgIdSchema, type OrgId } from '../../domain/ids';
import type { EngineRecord, EngineStore } from '../../domain/registration/engine-store';
import type { LinkCodeStore } from '../../domain/registration/link-code-store';
import type { Database } from './client';
import { engines, linkCodes } from './schema';

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
    const engineExists = (engineId: EngineId) =>
        db
            .select({ one: sql`1` })
            .from(engines)
            .where(eq(engines.engineId, engineId));

    return {
        async insert(record) {
            await db.insert(linkCodes).values(record);
        },

        async countActive(orgId, now) {
            const row = await db
                .select({ total: count() })
                .from(linkCodes)
                .where(and(eq(linkCodes.orgId, orgId), isNull(linkCodes.usedAt), gt(linkCodes.expiresAt, now)))
                .get();
            return row?.total ?? 0;
        },

        async countIssuedSince(orgId, since) {
            const row = await db
                .select({ total: count() })
                .from(linkCodes)
                .where(and(eq(linkCodes.orgId, orgId), gt(linkCodes.createdAt, since)))
                .get();
            return row?.total ?? 0;
        },

        async findRedeemable(codeHash, now) {
            const row = await db
                .select({ orgId: linkCodes.orgId })
                .from(linkCodes)
                .where(and(eq(linkCodes.codeHash, codeHash), isNull(linkCodes.usedAt), gt(linkCodes.expiresAt, now)))
                .get();
            return row === undefined ? null : orgIdSchema.parse(row.orgId);
        },

        async redeemForNewEngine(codeHash, engine) {
            const now = engine.createdAt;
            const [consumed] = await db.batch([
                db
                    .update(linkCodes)
                    .set({ usedAt: now, engineId: engine.engineId })
                    .where(and(redeemable(codeHash, engine.orgId, now), notExists(engineExists(engine.engineId))))
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
                    .set({ usedAt: refresh.now, engineId: refresh.engineId })
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

/** Every organization-facing query filters by `org_id`; `findForRegistration` is the documented exception. */
export function createD1EngineStore(db: Database): EngineStore {
    return {
        async countActive(orgId) {
            const row = await db
                .select({ total: count() })
                .from(engines)
                .where(and(eq(engines.orgId, orgId), eq(engines.status, 'active')))
                .get();
            return row?.total ?? 0;
        },

        async findForRegistration(engineId) {
            const row = await db.select().from(engines).where(eq(engines.engineId, engineId)).get();
            return row === undefined ? null : toEngine(row);
        },
    };
}
