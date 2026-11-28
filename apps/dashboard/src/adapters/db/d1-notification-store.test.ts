import { env } from 'cloudflare:workers';

import { testAccount } from '../../testing/auth-store-contract';
import { describeNotificationStoreContract } from '../../testing/notification-store-contract';
import { createDatabase } from './client';
import { createD1AuthStore } from './d1-auth-store';
import { createD1NotificationStore } from './d1-notification-store';

describeNotificationStoreContract('D1', () => {
    const db = createDatabase(env.DB);
    return {
        store: createD1NotificationStore(db),
        async addOrg(userCount) {
            const owner = testAccount();
            await createD1AuthStore(db).accounts.createAccount(owner);
            const others = Array.from({ length: Math.max(0, userCount - 1) }, () => testAccount().user);
            for (const user of others) {
                await env.DB.prepare(
                    'INSERT INTO users (id, email, email_verified_at, locale, created_at, webauthn_user_id) VALUES (?, ?, ?, ?, ?, ?)',
                )
                    .bind(user.id, user.email, user.emailVerifiedAt, user.locale, user.createdAt, user.webauthnUserId)
                    .run();
            }
            return { orgId: owner.orgId, userIds: userCount === 0 ? [] : [owner.userId, ...others.map((u) => u.id)] };
        },
    };
});
