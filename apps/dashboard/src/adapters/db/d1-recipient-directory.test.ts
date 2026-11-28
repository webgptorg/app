import { env } from 'cloudflare:workers';

import { describeRecipientDirectoryContract } from '../../testing/recipient-directory-contract';
import { createDatabase } from './client';
import { createD1AuthStore } from './d1-auth-store';
import { createD1RecipientDirectory } from './d1-recipient-directory';
import { createD1HeartbeatEngineReader } from './d1-status-store';

describeRecipientDirectoryContract('D1', () => {
    const db = createDatabase(env.DB);
    return {
        directory: createD1RecipientDirectory(db),
        engines: createD1HeartbeatEngineReader(db),
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
        async addEngine(engine) {
            await env.DB.prepare(
                'INSERT INTO engines (engine_id, org_id, public_key, hostname, mode, engine_version, status, status_reason, created_at, updated_at, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
                .bind(
                    engine.engineId,
                    engine.orgId,
                    engine.publicKey,
                    engine.hostname,
                    engine.mode,
                    engine.engineVersion,
                    engine.status,
                    engine.statusReason,
                    engine.createdAt,
                    engine.updatedAt,
                    engine.label,
                )
                .run();
        },
        async addTeam(orgId, engineId, name, people) {
            const teamId = engineId;
            await env.DB.batch([
                env.DB.prepare('INSERT INTO teams (id, org_id, name, created_at) VALUES (?, ?, ?, 0)').bind(
                    teamId,
                    orgId,
                    name,
                ),
                env.DB.prepare('UPDATE engines SET team_id = ? WHERE engine_id = ?').bind(teamId, engineId),
                ...people.map(([userId, access]) =>
                    env.DB.prepare(
                        'INSERT INTO team_members (team_id, user_id, created_at, access) VALUES (?, ?, 0, ?)',
                    ).bind(teamId, userId, access),
                ),
            ]);
        },
        async addLinker(orgId, engineId, userId) {
            await env.DB.prepare(
                'INSERT INTO link_codes (code_hash, id, org_id, created_by_user_id, created_at, expires_at, used_at, engine_id) VALUES (?, ?, ?, ?, 0, 1, 1, ?)',
            )
                .bind(crypto.randomUUID(), crypto.randomUUID(), orgId, userId, engineId)
                .run();
        },
        async addTicket(engineId, userId, ticket) {
            await env.DB.prepare(
                'INSERT INTO access_tickets (id, team_id, engine_id, user_id, issued_at, expires_at, noticed_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            )
                .bind(
                    crypto.randomUUID(),
                    engineId,
                    engineId,
                    userId,
                    ticket.issuedAt,
                    ticket.issuedAt + 1,
                    ticket.noticed ? ticket.issuedAt : null,
                )
                .run();
        },
    };
});
