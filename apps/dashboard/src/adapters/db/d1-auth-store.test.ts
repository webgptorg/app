import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { describeAuthStoreContract, testAccount } from '../../testing/auth-store-contract';
import { createDatabase } from './client';
import { createD1AuthStore } from './d1-auth-store';

describeAuthStoreContract('D1', () => createD1AuthStore(createDatabase(env.DB)));

describe('D1 auth store', () => {
    it('stores blobs as bytes, not as text or JSON', async () => {
        const account = testAccount();
        await createD1AuthStore(createDatabase(env.DB)).accounts.createAccount(account);
        const row = await env.DB.prepare(
            'SELECT typeof(public_key) AS type, length(public_key) AS size FROM passkeys WHERE credential_id = ?',
        )
            .bind(account.passkey.credentialId)
            .first<{ type: string; size: number }>();
        expect(row).toEqual({ type: 'blob', size: 77 });
    });

    it('rethrows a failure that is not a uniqueness conflict', async () => {
        const store = createD1AuthStore(createDatabase(env.DB));
        const broken = {
            user: { id: 'x' },
        } as unknown as Parameters<typeof store.accounts.createAccount>[0];
        await expect(store.accounts.createAccount(broken)).rejects.toThrow();
    });
});
