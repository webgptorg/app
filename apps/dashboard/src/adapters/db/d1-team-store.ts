import { EngineId } from '@ptbk/protocol';
import { and, asc, count, desc, eq, gt, inArray, is, isNull, SQL, sql } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

import {
    inviteIdSchema,
    orgIdSchema,
    teamIdSchema,
    userIdSchema,
    type OrgId,
    type TeamId,
    type UserId,
} from '../../domain/ids';
import { orgRoleSchema } from '../../domain/roles';
import type {
    InviteRecord,
    OrgMemberRecord,
    PersonRecord,
    TeamAudit,
    TeamRecord,
    TeamStore,
} from '../../domain/teams/team-store';
import { teamNameSchema } from '../../shared/team-name';
import type { Database } from './client';
import {
    engines,
    invites,
    linkCodes,
    memberRevocations,
    memberships,
    orgAuditLog,
    organizations,
    teamMembers,
    teams,
    users,
} from './schema';

const teamIdsSchema = z.array(teamIdSchema);

// A row ID the engine will ack a revocation by; random, like every other ID, but made in SQL so one statement can queue
// a revocation per affected engine.
const RANDOM_ID = sql`lower(hex(randomblob(16)))`;

const dialect = new SQLiteSyncDialect();

/**
 * One D1 transaction over drizzle queries and raw statements alike: drizzle's own `batch` cannot carry raw SQL, and
 * queuing revocations needs INSERT … SELECT forms its builder does not have.
 */
function transaction(
    db: Database,
    queries: readonly (SQL | { toSQL(): { readonly sql: string; readonly params: unknown[] } })[],
): Promise<readonly D1Result[]> {
    return db.$client.batch(
        queries.map((query) => {
            const { sql: text, params } = is(query, SQL) ? dialect.sqlToQuery(query) : query.toSQL();
            return db.$client.prepare(text).bind(...params);
        }),
    );
}

const live = (orgId: OrgId) => and(eq(teams.orgId, orgId), isNull(teams.deletedAt));

function audit(orgId: OrgId, entry: TeamAudit, action: string, targetType: string, targetId: string) {
    return {
        id: entry.id,
        orgId,
        actorUserId: entry.actorUserId,
        action,
        targetType,
        targetId,
        createdAt: entry.at,
    };
}

function toInvite(row: typeof invites.$inferSelect): InviteRecord {
    return {
        id: inviteIdSchema.parse(row.id),
        tokenHash: row.tokenHash,
        orgId: orgIdSchema.parse(row.orgId),
        email: row.email,
        role: orgRoleSchema.parse(row.role),
        teamIds: teamIdsSchema.parse(JSON.parse(row.teamIds)),
        invitedByUserId: userIdSchema.parse(row.invitedByUserId),
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
    };
}

const pending = (now: number) => and(isNull(invites.acceptedAt), isNull(invites.revokedAt), gt(invites.expiresAt, now));

/** Teams, their people and invitations in D1 (ADR 0018); see {@link TeamStore} for the rules each method keeps. */
export function createD1TeamStore(db: Database): TeamStore {
    const memberCount = db
        .select({ teamId: teamMembers.teamId, n: count().as('n') })
        .from(teamMembers)
        .groupBy(teamMembers.teamId)
        .as('member_count');
    const teamColumns = {
        id: teams.id,
        orgId: teams.orgId,
        name: teams.name,
        createdAt: teams.createdAt,
        engineId: engines.engineId,
        memberCount: memberCount.n,
    };
    const toTeam = (row: {
        id: string;
        orgId: string;
        name: string;
        createdAt: number;
        engineId: string | null;
        memberCount: number | null;
    }): TeamRecord => ({
        id: teamIdSchema.parse(row.id),
        orgId: orgIdSchema.parse(row.orgId),
        name: teamNameSchema.parse(row.name),
        createdAt: row.createdAt,
        engineId: row.engineId === null ? null : EngineId.parse(row.engineId),
        memberCount: row.memberCount ?? 0,
    });
    const selectTeams = () =>
        db
            .select(teamColumns)
            .from(teams)
            .leftJoin(engines, eq(engines.teamId, teams.id))
            .leftJoin(memberCount, eq(memberCount.teamId, teams.id));

    async function find(orgId: OrgId, teamId: TeamId) {
        const row = await selectTeams()
            .where(and(eq(teams.id, teamId), live(orgId)))
            .get();
        return row === undefined ? null : toTeam(row);
    }

    async function isOrgMember(orgId: OrgId, userId: UserId) {
        const row = await db
            .select({ role: memberships.role })
            .from(memberships)
            .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
            .get();
        return row === undefined ? null : orgRoleSchema.parse(row.role);
    }

    async function isMember(orgId: OrgId, teamId: TeamId, userId: UserId) {
        const row = await db
            .select({ teamId: teamMembers.teamId })
            .from(teamMembers)
            .innerJoin(teams, eq(teams.id, teamMembers.teamId))
            .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId), live(orgId)))
            .get();
        return row !== undefined;
    }

    // Queues a revocation on the engine of every live team of `orgId` that `userId` is in; the caller narrows it further.
    const queueRevocations = (orgId: OrgId, userId: UserId, at: number) => sql`
        INSERT INTO ${memberRevocations} (id, engine_id, user_id, created_at, acked_at, outcome)
        SELECT ${RANDOM_ID}, ${engines.engineId}, ${userId}, ${at}, NULL, NULL
        FROM ${teamMembers}
        INNER JOIN ${teams} ON ${teams.id} = ${teamMembers.teamId}
        INNER JOIN ${engines} ON ${engines.teamId} = ${teams.id}
        WHERE ${teamMembers.userId} = ${userId} AND ${teams.orgId} = ${orgId} AND ${teams.deletedAt} IS NULL`;

    // The organization keeps an owner: true unless `userId` is its only one.
    const notLastOwner = (orgId: OrgId, userId: UserId) => sql`NOT EXISTS (
        SELECT 1 FROM ${memberships} AS m
        WHERE m.org_id = ${orgId} AND m.user_id = ${userId} AND m.role = 'owner'
            AND (SELECT count(*) FROM ${memberships} AS o WHERE o.org_id = ${orgId} AND o.role = 'owner') = 1)`;

    return {
        async create(team, creator, entry) {
            await db.batch([
                db.insert(teams).values({ ...team, deletedAt: null }),
                db.insert(teamMembers).values({ teamId: team.id, userId: creator, createdAt: team.createdAt }),
                db.insert(orgAuditLog).values(audit(team.orgId, entry, 'team.create', 'team', team.id)),
            ]);
        },

        async list(orgId) {
            const rows = await selectTeams().where(live(orgId)).orderBy(asc(teams.createdAt), asc(teams.id)).all();
            return rows.map(toTeam);
        },

        async listForUser(orgId, userId) {
            const rows = await selectTeams()
                .innerJoin(teamMembers, and(eq(teamMembers.teamId, teams.id), eq(teamMembers.userId, userId)))
                .where(live(orgId))
                .orderBy(asc(teams.createdAt), asc(teams.id))
                .all();
            return rows.map(toTeam);
        },

        find,
        isMember,

        async rename(orgId, teamId, name, entry) {
            if ((await find(orgId, teamId)) === null) {
                return 'not-found';
            }
            await db.batch([
                db.update(teams).set({ name }).where(eq(teams.id, teamId)),
                db.insert(orgAuditLog).values(audit(orgId, entry, 'team.rename', 'team', teamId)),
            ]);
            return 'renamed';
        },

        async delete(orgId, teamId, entry) {
            if ((await find(orgId, teamId)) === null) {
                return 'not-found';
            }
            await transaction(db, [
                sql`
                    INSERT INTO ${memberRevocations} (id, engine_id, user_id, created_at, acked_at, outcome)
                    SELECT ${RANDOM_ID}, ${engines.engineId}, ${teamMembers.userId}, ${entry.at}, NULL, NULL
                    FROM ${teamMembers} INNER JOIN ${engines} ON ${engines.teamId} = ${teamMembers.teamId}
                    WHERE ${teamMembers.teamId} = ${teamId}`,
                db.delete(teamMembers).where(eq(teamMembers.teamId, teamId)),
                db.update(teams).set({ deletedAt: entry.at }).where(eq(teams.id, teamId)),
                db.insert(orgAuditLog).values(audit(orgId, entry, 'team.delete', 'team', teamId)),
            ]);
            return 'deleted';
        },

        async listMembers(orgId, teamId) {
            const rows = await db
                .select({
                    userId: teamMembers.userId,
                    email: users.email,
                    role: memberships.role,
                    joinedAt: teamMembers.createdAt,
                })
                .from(teamMembers)
                .innerJoin(teams, eq(teams.id, teamMembers.teamId))
                .innerJoin(users, eq(users.id, teamMembers.userId))
                .innerJoin(memberships, and(eq(memberships.userId, users.id), eq(memberships.orgId, teams.orgId)))
                .where(and(eq(teamMembers.teamId, teamId), live(orgId)))
                .orderBy(asc(users.email))
                .all();
            return rows.map((row): PersonRecord => ({
                userId: userIdSchema.parse(row.userId),
                email: row.email,
                role: orgRoleSchema.parse(row.role),
                joinedAt: row.joinedAt,
            }));
        },

        async addMember(orgId, teamId, userId, entry) {
            if ((await find(orgId, teamId)) === null) {
                return 'not-found';
            }
            if ((await isOrgMember(orgId, userId)) === null) {
                return 'not-member';
            }
            if (await isMember(orgId, teamId, userId)) {
                return 'already';
            }
            await db.batch([
                db.insert(teamMembers).values({ teamId, userId, createdAt: entry.at }).onConflictDoNothing(),
                db.insert(orgAuditLog).values(audit(orgId, entry, 'team.member.add', 'user', userId)),
            ]);
            return 'added';
        },

        async removeMember(orgId, teamId, userId, entry) {
            if (!(await isMember(orgId, teamId, userId))) {
                return 'not-found';
            }
            await transaction(db, [
                sql`${queueRevocations(orgId, userId, entry.at)} AND ${teams.id} = ${teamId}`,
                db.delete(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))),
                db.insert(orgAuditLog).values(audit(orgId, entry, 'team.member.remove', 'user', userId)),
            ]);
            return 'removed';
        },

        async engineIdsForUser(orgId, userId) {
            const rows = await db
                .select({ engineId: engines.engineId })
                .from(engines)
                .innerJoin(teams, eq(teams.id, engines.teamId))
                .innerJoin(teamMembers, and(eq(teamMembers.teamId, teams.id), eq(teamMembers.userId, userId)))
                .where(live(orgId))
                .all();
            return new Set(rows.map((row) => EngineId.parse(row.engineId)));
        },

        async attachLinkCode(orgId, linkCodeId, teamId) {
            const team = await find(orgId, teamId);
            if (team?.engineId !== null) {
                return 'not-found';
            }
            const rows = await db
                .update(linkCodes)
                .set({ teamId })
                .where(and(eq(linkCodes.id, linkCodeId), eq(linkCodes.orgId, orgId), isNull(linkCodes.usedAt)))
                .returning({ id: linkCodes.id });
            return rows.length === 1 ? 'attached' : 'not-found';
        },

        async bindNewEngine(engineId, fallback) {
            const engine = await db
                .select({ orgId: engines.orgId, teamId: engines.teamId })
                .from(engines)
                .where(eq(engines.engineId, engineId))
                .get();
            if (engine === undefined || engine.teamId !== null) {
                return;
            }
            const orgId = orgIdSchema.parse(engine.orgId);
            const code = await db
                .select({ teamId: linkCodes.teamId, createdBy: linkCodes.createdByUserId })
                .from(linkCodes)
                .where(eq(linkCodes.engineId, engineId))
                .orderBy(desc(linkCodes.usedAt))
                .get();
            const named = code?.teamId == null ? null : await find(orgId, teamIdSchema.parse(code.teamId));
            if (named !== null && named.engineId === null) {
                await db.update(engines).set({ teamId: named.id }).where(eq(engines.engineId, engineId));
                return;
            }
            const creator = code === undefined ? null : userIdSchema.parse(code.createdBy);
            const stillMember = creator !== null && (await isOrgMember(orgId, creator)) !== null;
            await db.batch([
                db.insert(teams).values({
                    id: fallback.teamId,
                    orgId,
                    name: fallback.name,
                    createdAt: fallback.at,
                    deletedAt: null,
                }),
                db.update(engines).set({ teamId: fallback.teamId }).where(eq(engines.engineId, engineId)),
                ...(stillMember
                    ? [
                          db
                              .insert(teamMembers)
                              .values({ teamId: fallback.teamId, userId: creator, createdAt: fallback.at }),
                      ]
                    : []),
            ]);
        },

        async listOrgMembers(orgId) {
            const [people, teamRows] = await Promise.all([
                db
                    .select({
                        userId: memberships.userId,
                        email: users.email,
                        role: memberships.role,
                        joinedAt: memberships.createdAt,
                    })
                    .from(memberships)
                    .innerJoin(users, eq(users.id, memberships.userId))
                    .where(eq(memberships.orgId, orgId))
                    .orderBy(asc(users.email))
                    .all(),
                db
                    .select({ userId: teamMembers.userId, teamId: teamMembers.teamId })
                    .from(teamMembers)
                    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
                    .where(live(orgId))
                    .orderBy(asc(teams.createdAt), asc(teams.id))
                    .all(),
            ]);
            return people.map((row): OrgMemberRecord => ({
                userId: userIdSchema.parse(row.userId),
                email: row.email,
                role: orgRoleSchema.parse(row.role),
                joinedAt: row.joinedAt,
                teamIds: teamRows
                    .filter((team) => team.userId === row.userId)
                    .map((team) => teamIdSchema.parse(team.teamId)),
            }));
        },

        async changeRole(orgId, userId, role, entry) {
            const current = await isOrgMember(orgId, userId);
            if (current === null) {
                return 'not-found';
            }
            if (current === role) {
                return 'unchanged';
            }
            const [changed] = await db.batch([
                db
                    .update(memberships)
                    .set({ role })
                    .where(
                        and(eq(memberships.orgId, orgId), eq(memberships.userId, userId), notLastOwner(orgId, userId)),
                    )
                    .returning({ userId: memberships.userId }),
                db.insert(orgAuditLog).select((qb) =>
                    qb
                        .select({
                            id: sql`${entry.id}`.as('id'),
                            orgId: memberships.orgId,
                            actorUserId: sql`${entry.actorUserId}`.as('actor_user_id'),
                            action: sql`'org.member.role'`.as('action'),
                            targetType: sql`'user'`.as('target_type'),
                            targetId: memberships.userId,
                            createdAt: sql`${entry.at}`.as('created_at'),
                        })
                        .from(memberships)
                        .where(
                            and(
                                eq(memberships.orgId, orgId),
                                eq(memberships.userId, userId),
                                eq(memberships.role, role),
                            ),
                        ),
                ),
            ]);
            return changed.length === 1 ? 'changed' : 'last-owner';
        },

        async removeFromOrg(orgId, userId, entry) {
            if ((await isOrgMember(orgId, userId)) === null) {
                return 'not-found';
            }
            const keep = notLastOwner(orgId, userId);
            const [, , removed] = await transaction(db, [
                sql`${queueRevocations(orgId, userId, entry.at)} AND ${keep}`,
                sql`
                    DELETE FROM ${teamMembers} WHERE ${teamMembers.userId} = ${userId}
                        AND ${teamMembers.teamId} IN (SELECT ${teams.id} FROM ${teams} WHERE ${teams.orgId} = ${orgId})
                        AND ${keep}`,
                db
                    .delete(memberships)
                    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId), keep))
                    .returning({ userId: memberships.userId }),
            ]);
            if (removed?.results.length !== 1) {
                return 'last-owner';
            }
            await db.insert(orgAuditLog).values(audit(orgId, entry, 'org.member.remove', 'user', userId));
            return 'removed';
        },

        async insertInvite(invite, entry) {
            await db.batch([
                db.insert(invites).values({
                    ...invite,
                    teamIds: JSON.stringify(invite.teamIds),
                    acceptedAt: null,
                    revokedAt: null,
                }),
                db.insert(orgAuditLog).values(audit(invite.orgId, entry, 'invite.create', 'invite', invite.id)),
            ]);
        },

        async listPendingInvites(orgId, now) {
            const rows = await db
                .select()
                .from(invites)
                .where(and(eq(invites.orgId, orgId), pending(now)))
                .orderBy(desc(invites.createdAt), asc(invites.id))
                .all();
            return rows.map(toInvite);
        },

        async previewInvite(tokenHash, now) {
            const row = await db
                .select({ invite: invites, orgName: organizations.name })
                .from(invites)
                .innerJoin(organizations, eq(organizations.id, invites.orgId))
                .where(and(eq(invites.tokenHash, tokenHash), pending(now)))
                .get();
            if (row === undefined) {
                return null;
            }
            const invite = toInvite(row.invite);
            const names =
                invite.teamIds.length === 0
                    ? []
                    : await db
                          .select({ name: teams.name })
                          .from(teams)
                          .where(and(inArray(teams.id, [...invite.teamIds]), live(invite.orgId)))
                          .orderBy(asc(teams.createdAt), asc(teams.id))
                          .all();
            return { invite, orgName: row.orgName, teamNames: names.map((team) => teamNameSchema.parse(team.name)) };
        },

        async renewInvite(orgId, inviteId, renewal, entry) {
            const [rows] = await db.batch([
                db
                    .update(invites)
                    .set({ tokenHash: renewal.tokenHash, expiresAt: renewal.expiresAt })
                    .where(and(eq(invites.id, inviteId), eq(invites.orgId, orgId), pending(renewal.now)))
                    .returning(),
                db.insert(orgAuditLog).select((qb) =>
                    qb
                        .select({
                            id: sql`${entry.id}`.as('id'),
                            orgId: invites.orgId,
                            actorUserId: sql`${entry.actorUserId}`.as('actor_user_id'),
                            action: sql`'invite.resend'`.as('action'),
                            targetType: sql`'invite'`.as('target_type'),
                            targetId: invites.id,
                            createdAt: sql`${entry.at}`.as('created_at'),
                        })
                        .from(invites)
                        .where(and(eq(invites.id, inviteId), eq(invites.tokenHash, renewal.tokenHash))),
                ),
            ]);
            const [row] = rows;
            return row === undefined ? null : toInvite(row);
        },

        async revokeInvite(orgId, inviteId, entry) {
            const rows = await db
                .update(invites)
                .set({ revokedAt: entry.at })
                .where(and(eq(invites.id, inviteId), eq(invites.orgId, orgId), pending(entry.at)))
                .returning({ id: invites.id });
            if (rows.length === 0) {
                return 'not-found';
            }
            await db.insert(orgAuditLog).values(audit(orgId, entry, 'invite.revoke', 'invite', inviteId));
            return 'revoked';
        },

        async acceptInvite(tokenHash, userId, entry) {
            const spent = and(eq(invites.tokenHash, tokenHash), eq(invites.acceptedAt, entry.at));
            const [accepted] = await transaction(db, [
                db
                    .update(invites)
                    .set({ acceptedAt: entry.at })
                    .where(and(eq(invites.tokenHash, tokenHash), pending(entry.at)))
                    .returning({ orgId: invites.orgId }),
                sql`
                    INSERT INTO ${memberships} (org_id, user_id, role, created_at)
                    SELECT ${invites.orgId}, ${userId}, ${invites.role}, ${entry.at} FROM ${invites} WHERE ${spent}
                    ON CONFLICT DO NOTHING`,
                sql`
                    INSERT INTO ${teamMembers} (team_id, user_id, created_at)
                    SELECT ${teams.id}, ${userId}, ${entry.at}
                    FROM ${invites}, json_each(${invites.teamIds}) AS invited
                    INNER JOIN ${teams} ON ${teams.id} = invited.value
                    WHERE ${spent} AND ${teams.orgId} = ${invites.orgId} AND ${teams.deletedAt} IS NULL
                    ON CONFLICT DO NOTHING`,
                sql`
                    INSERT INTO ${orgAuditLog} (id, org_id, actor_user_id, action, target_type, target_id, created_at)
                    SELECT ${entry.id}, ${invites.orgId}, ${userId}, 'invite.accept', 'invite', ${invites.id}, ${entry.at}
                    FROM ${invites} WHERE ${spent}`,
            ]);
            const [row] = accepted?.results ?? [];
            return row === undefined
                ? { kind: 'invalid' }
                : { kind: 'accepted', orgId: orgIdSchema.parse((row as { readonly org_id: unknown }).org_id) };
        },
    };
}
