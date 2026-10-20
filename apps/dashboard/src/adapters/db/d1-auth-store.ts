import { and, asc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { AuthStore } from '../../domain/auth/auth-store';
import type {
    ChallengeRecord,
    EmailTokenRecord,
    MembershipView,
    PasskeyRecord,
    SessionRecord,
    UserRecord,
} from '../../domain/auth/records';
import { orgIdSchema, userIdSchema } from '../../domain/ids';
import { localeSchema } from '../../domain/locale';
import { orgRoleSchema, platformRoleSchema } from '../../domain/roles';
import type { Database } from './client';
import {
    emailTokens,
    memberships,
    organizations,
    passkeys,
    sessions,
    users,
    webauthnChallenges,
    adminAuditLog,
} from './schema';

const transportsSchema = z.array(z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']));
const ceremonySchema = z.enum(['signup', 'signin', 'recovery', 'step-up', 'passkey-add']);

/**
 * Drizzle's `blob({ mode: 'buffer' })` reads a Node `Buffer` (nodejs_compat) and writes whatever it is given, which D1
 * binds as bytes. The domain only ever sees a plain, unshared `Uint8Array`.
 */
function bytes(buffer: unknown): Uint8Array {
    if (!(buffer instanceof Uint8Array)) {
        throw new TypeError('blob column did not read as bytes');
    }
    return Uint8Array.from(buffer);
}

function isUniqueViolation(error: unknown): boolean {
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
        if (current.message.includes('UNIQUE constraint failed')) {
            return true;
        }
    }
    return false;
}

function toUser(row: typeof users.$inferSelect): UserRecord {
    if (row.webauthnUserId === null) {
        // Only rows from before D-02 could lack it, and none were ever created.
        throw new Error('user row without a WebAuthn user handle');
    }
    return {
        id: userIdSchema.parse(row.id),
        email: row.email,
        emailVerifiedAt: row.emailVerifiedAt,
        locale: localeSchema.parse(row.locale),
        platformRole: platformRoleSchema.parse(row.platformRole),
        recoveredAt: row.recoveredAt,
        createdAt: row.createdAt,
        webauthnUserId: bytes(row.webauthnUserId),
    };
}

function toPasskey(row: typeof passkeys.$inferSelect): PasskeyRecord {
    return {
        credentialId: row.credentialId,
        userId: userIdSchema.parse(row.userId),
        publicKey: bytes(row.publicKey),
        counter: row.counter,
        transports: transportsSchema.parse(JSON.parse(row.transports ?? '[]')),
        backedUp: row.backedUp,
        addedVia: row.addedVia,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        counterRegressedAt: row.counterRegressedAt,
    };
}

function passkeyRow(passkey: PasskeyRecord): typeof passkeys.$inferInsert {
    return {
        ...passkey,
        publicKey: passkey.publicKey,
        transports: JSON.stringify(passkey.transports),
    };
}

function toSession(row: typeof sessions.$inferSelect): SessionRecord {
    return { ...row, userId: userIdSchema.parse(row.userId), activeOrgId: orgIdSchema.parse(row.activeOrgId) };
}

function toChallenge(row: typeof webauthnChallenges.$inferSelect): ChallengeRecord {
    return {
        ...row,
        purpose: ceremonySchema.parse(row.purpose),
        userId: row.userId === null ? null : userIdSchema.parse(row.userId),
        webauthnUserId: row.webauthnUserId === null ? null : bytes(row.webauthnUserId),
    };
}

function toEmailToken(row: typeof emailTokens.$inferSelect): EmailTokenRecord {
    return { ...row, userId: row.userId === null ? null : userIdSchema.parse(row.userId) };
}

function toMembership(row: {
    membership: typeof memberships.$inferSelect;
    org: typeof organizations.$inferSelect;
}): MembershipView {
    const orgId = orgIdSchema.parse(row.membership.orgId);
    return {
        orgId,
        userId: userIdSchema.parse(row.membership.userId),
        role: orgRoleSchema.parse(row.membership.role),
        createdAt: row.membership.createdAt,
        org: { id: orgId, kind: row.org.kind, name: row.org.name, createdAt: row.org.createdAt },
    };
}

/** D1 through Drizzle's core query builder. Multi-row changes run in one `db.batch`, which D1 applies atomically. */
export function createD1AuthStore(db: Database): AuthStore {
    const membershipQuery = () =>
        db
            .select({ membership: memberships, org: organizations })
            .from(memberships)
            .innerJoin(organizations, eq(organizations.id, memberships.orgId));

    return {
        accounts: {
            async findUser(userId) {
                const row = await db.select().from(users).where(eq(users.id, userId)).get();
                return row === undefined ? null : toUser(row);
            },
            async findUserByEmail(email) {
                const row = await db.select().from(users).where(eq(users.email, email)).get();
                return row === undefined ? null : toUser(row);
            },
            async findMembership(orgId, userId) {
                const row = await membershipQuery()
                    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
                    .get();
                return row === undefined ? null : toMembership(row);
            },
            async listMemberships(userId) {
                const rows = await membershipQuery()
                    .where(eq(memberships.userId, userId))
                    .orderBy(asc(memberships.createdAt), asc(memberships.orgId))
                    .all();
                return rows.map(toMembership);
            },
            async createAccount(input) {
                try {
                    await db.batch([
                        db.insert(users).values({ ...input.user, webauthnUserId: input.user.webauthnUserId }),
                        db.insert(organizations).values(input.org),
                        db.insert(memberships).values(input.membership),
                        db.insert(passkeys).values(passkeyRow(input.passkey)),
                        db.insert(sessions).values(input.session),
                    ]);
                    return 'created';
                } catch (error) {
                    if (isUniqueViolation(error)) {
                        return 'conflict';
                    }
                    throw error;
                }
            },
            async recoverAccount(input) {
                try {
                    await db.batch([
                        db.insert(passkeys).values(passkeyRow(input.passkey)),
                        db
                            .update(sessions)
                            .set({ revokedAt: input.recoveredAt })
                            .where(and(eq(sessions.userId, input.userId), isNull(sessions.revokedAt))),
                        db.update(users).set({ recoveredAt: input.recoveredAt }).where(eq(users.id, input.userId)),
                        db.insert(sessions).values(input.session),
                    ]);
                    return 'recovered';
                } catch (error) {
                    if (isUniqueViolation(error)) {
                        return 'conflict';
                    }
                    throw error;
                }
            },
        },

        passkeys: {
            async find(credentialId) {
                const row = await db.select().from(passkeys).where(eq(passkeys.credentialId, credentialId)).get();
                return row === undefined ? null : toPasskey(row);
            },
            async listForUser(userId) {
                const rows = await db
                    .select()
                    .from(passkeys)
                    .where(eq(passkeys.userId, userId))
                    .orderBy(asc(passkeys.createdAt), asc(passkeys.credentialId))
                    .all();
                return rows.map(toPasskey);
            },
            async add(passkey) {
                try {
                    await db.insert(passkeys).values(passkeyRow(passkey));
                    return 'added';
                } catch (error) {
                    if (isUniqueViolation(error)) {
                        return 'conflict';
                    }
                    throw error;
                }
            },
            async recordUse(userId, credentialId, counter, usedAt) {
                await db
                    .update(passkeys)
                    .set({ counter, lastUsedAt: usedAt })
                    .where(and(eq(passkeys.credentialId, credentialId), eq(passkeys.userId, userId)));
            },
            async flagCounterRegression(userId, credentialId, at) {
                await db
                    .update(passkeys)
                    .set({ counterRegressedAt: at })
                    .where(and(eq(passkeys.credentialId, credentialId), eq(passkeys.userId, userId)));
            },
            async deleteUnlessLast(userId, credentialId) {
                // One statement, so two concurrent deletes cannot both see "two left" and remove both.
                const deleted = await db
                    .delete(passkeys)
                    .where(
                        and(
                            eq(passkeys.credentialId, credentialId),
                            eq(passkeys.userId, userId),
                            sql`(select count(*) from ${passkeys} where ${passkeys.userId} = ${userId}) > 1`,
                        ),
                    )
                    .returning({ credentialId: passkeys.credentialId })
                    .all();
                if (deleted.length > 0) {
                    return 'deleted';
                }
                const owned = await db
                    .select({ credentialId: passkeys.credentialId })
                    .from(passkeys)
                    .where(and(eq(passkeys.credentialId, credentialId), eq(passkeys.userId, userId)))
                    .get();
                return owned === undefined ? 'not-found' : 'last';
            },
        },

        sessions: {
            async create(session) {
                await db.insert(sessions).values(session);
            },
            async find(idHash) {
                const row = await db.select().from(sessions).where(eq(sessions.idHash, idHash)).get();
                return row === undefined ? null : toSession(row);
            },
            async touch(idHash, lastSeenAt) {
                await db.update(sessions).set({ lastSeenAt }).where(eq(sessions.idHash, idHash));
            },
            async markSteppedUp(idHash, at) {
                await db.update(sessions).set({ steppedUpAt: at }).where(eq(sessions.idHash, idHash));
            },
            async revoke(idHash, at) {
                await db
                    .update(sessions)
                    .set({ revokedAt: at })
                    .where(and(eq(sessions.idHash, idHash), isNull(sessions.revokedAt)));
            },
            async revokeAllForUser(userId, at) {
                await db
                    .update(sessions)
                    .set({ revokedAt: at })
                    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
            },
            async listActiveForUser(userId, now) {
                const rows = await db
                    .select()
                    .from(sessions)
                    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)))
                    .orderBy(asc(sessions.createdAt))
                    .all();
                return rows.map(toSession);
            },
        },

        challenges: {
            async create(challenge, now) {
                await db.batch([
                    db.delete(webauthnChallenges).where(lte(webauthnChallenges.expiresAt, now)),
                    db.insert(webauthnChallenges).values({
                        ...challenge,
                        webauthnUserId: challenge.webauthnUserId,
                    }),
                ]);
            },
            async consume(id, now) {
                const row = await db
                    .delete(webauthnChallenges)
                    .where(and(eq(webauthnChallenges.id, id), gt(webauthnChallenges.expiresAt, now)))
                    .returning()
                    .get();
                return row === undefined ? null : toChallenge(row);
            },
        },

        emailTokens: {
            async issue(token) {
                await db.batch([
                    db
                        .delete(emailTokens)
                        .where(
                            or(
                                and(eq(emailTokens.email, token.email), eq(emailTokens.purpose, token.purpose)),
                                lte(emailTokens.expiresAt, token.createdAt),
                            ),
                        ),
                    db.insert(emailTokens).values(token),
                ]);
            },
            async findUsable(tokenHash, purpose, now) {
                const row = await db
                    .select()
                    .from(emailTokens)
                    .where(
                        and(
                            eq(emailTokens.tokenHash, tokenHash),
                            eq(emailTokens.purpose, purpose),
                            isNull(emailTokens.usedAt),
                            gt(emailTokens.expiresAt, now),
                        ),
                    )
                    .get();
                return row === undefined ? null : toEmailToken(row);
            },
            async consume(tokenHash, purpose, now) {
                const [row] = await db
                    .update(emailTokens)
                    .set({ usedAt: now })
                    .where(
                        and(
                            eq(emailTokens.tokenHash, tokenHash),
                            eq(emailTokens.purpose, purpose),
                            isNull(emailTokens.usedAt),
                            gt(emailTokens.expiresAt, now),
                        ),
                    )
                    .returning()
                    .all();
                return row === undefined ? null : toEmailToken(row);
            },
        },

        adminAudit: {
            async append(entry) {
                await db.insert(adminAuditLog).values(entry);
            },
        },
    };
}
