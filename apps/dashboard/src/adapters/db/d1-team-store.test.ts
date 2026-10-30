import { env } from 'cloudflare:workers';
import { asc, eq, sql } from 'drizzle-orm';

import { describeTeamStoreContract } from '../../testing/team-store-contract';
import { createDatabase } from './client';
import { createD1AuthStore } from './d1-auth-store';
import { createD1LinkCodeStore } from './d1-registration-store';
import { createD1TeamStore } from './d1-team-store';
import { engines, memberRevocations, orgAuditLog } from './schema';

describeTeamStoreContract('D1', () => {
    const db = createDatabase(env.DB);
    return {
        teams: createD1TeamStore(db),
        linkCodes: createD1LinkCodeStore(db),
        async addAccount(account) {
            await createD1AuthStore(db).accounts.createAccount(account);
        },
        async addMember(orgId, user, role) {
            await env.DB.batch([
                env.DB.prepare(
                    'INSERT INTO users (id, email, email_verified_at, locale, created_at, webauthn_user_id) VALUES (?, ?, ?, ?, ?, ?)',
                ).bind(user.id, user.email, user.emailVerifiedAt, user.locale, user.createdAt, user.webauthnUserId),
                env.DB.prepare('INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)').bind(
                    orgId,
                    user.id,
                    role,
                    user.createdAt,
                ),
            ]);
        },
        revocations: (orgId) =>
            db
                .select({ engineId: memberRevocations.engineId, userId: memberRevocations.userId })
                .from(memberRevocations)
                .innerJoin(engines, eq(engines.engineId, memberRevocations.engineId))
                .where(eq(engines.orgId, orgId))
                .orderBy(asc(memberRevocations.createdAt), sql`${memberRevocations}.rowid`)
                .all(),
        async auditActions(orgId) {
            const rows = await db
                .select({ action: orgAuditLog.action })
                .from(orgAuditLog)
                .where(eq(orgAuditLog.orgId, orgId))
                .orderBy(asc(orgAuditLog.createdAt), sql`${orgAuditLog}.rowid`)
                .all();
            return rows.map((row) => row.action);
        },
    };
});
