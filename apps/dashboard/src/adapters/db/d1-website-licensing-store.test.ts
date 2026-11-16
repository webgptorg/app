import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { testAccount } from '../../testing/auth-store-contract';
import {
    CONTRACT_WEBSITE_ORIGIN,
    describeWebsiteLicensingStoreContract,
} from '../../testing/website-licensing-store-contract';
import { createDatabase } from './client';
import { createD1AuthStore } from './d1-auth-store';
import { createD1WebsiteLicensingStore } from './d1-website-licensing-store';
import { orgAuditLog, websiteLicenseSnapshots } from './schema';

const clock = { nowMs: () => 1_800_000_000_000 };

describeWebsiteLicensingStoreContract('D1', () => {
    const db = createDatabase(env.DB);
    return {
        store: createD1WebsiteLicensingStore(db, { websiteOrigin: CONTRACT_WEBSITE_ORIGIN, clock }),
        async addOrg() {
            const account = testAccount();
            await createD1AuthStore(db).accounts.createAccount(account);
            return { orgId: account.orgId, userId: account.userId, email: account.user.email };
        },
        async linkAudit(orgId) {
            const rows = await db
                .select({ targetId: orgAuditLog.targetId })
                .from(orgAuditLog)
                .where(and(eq(orgAuditLog.orgId, orgId), eq(orgAuditLog.action, 'website.link')))
                .all();
            return rows.map((row) => row.targetId);
        },
    };
});

it('drops a stored snapshot that no longer validates, such as a manage link off the configured website', async () => {
    const db = createDatabase(env.DB);
    const account = testAccount();
    await createD1AuthStore(db).accounts.createAccount(account);
    const subject = crypto.randomUUID();
    const snapshot = {
        version: 1 as const,
        subject,
        generatedAt: '2026-11-13T00:00:00.000Z',
        refreshAfterSeconds: 900,
        enforcement: 'advisory' as const,
        manageUrl: `${CONTRACT_WEBSITE_ORIGIN}/cs/pricing/predplatne`,
        grants: [],
    };
    await createD1WebsiteLicensingStore(db, { websiteOrigin: CONTRACT_WEBSITE_ORIGIN, clock }).saveSnapshot(
        account.orgId,
        snapshot,
    );
    const row = await db
        .select()
        .from(websiteLicenseSnapshots)
        .where(eq(websiteLicenseSnapshots.orgId, account.orgId))
        .get();
    expect(row?.fetchedAt).toBe(clock.nowMs());
    const moved = createD1WebsiteLicensingStore(db, { websiteOrigin: 'https://staging.ptbk.io', clock });
    expect(await moved.readSnapshot(account.orgId)).toBeNull();
    await db
        .update(websiteLicenseSnapshots)
        .set({ snapshot: '{' })
        .where(eq(websiteLicenseSnapshots.orgId, account.orgId));
    expect(
        await createD1WebsiteLicensingStore(db, { websiteOrigin: CONTRACT_WEBSITE_ORIGIN, clock }).readSnapshot(
            account.orgId,
        ),
    ).toBeNull();
});
