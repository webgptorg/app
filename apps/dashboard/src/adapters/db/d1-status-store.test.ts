import { env } from 'cloudflare:workers';

import { describeStatusStoreContract } from '../../testing/status-store-contract';
import { createDatabase } from './client';
import { createD1AuthStore } from './d1-auth-store';
import { createD1AlertRecipients, createD1HeartbeatEngineReader } from './d1-status-store';

describeStatusStoreContract('D1', () => {
    const db = createDatabase(env.DB);
    return {
        recipients: createD1AlertRecipients(db),
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
                'INSERT INTO engines (engine_id, org_id, public_key, hostname, mode, engine_version, status, status_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
                )
                .run();
        },
    };
});
