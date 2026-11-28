import { eq } from 'drizzle-orm';
import type { PublicClientStore } from '../registration/digitalocean-client';
import type { Database } from './client';
import { vpsOauthClients } from './schema';

export function createD1VpsClientStore(db: Database): PublicClientStore {
    const get = async (callback: string) =>
        (await db.select().from(vpsOauthClients).where(eq(vpsOauthClients.callback, callback)).get())?.clientId ?? null;
    return {
        get,
        async retain(callback, clientId) {
            await db.insert(vpsOauthClients).values({ callback, clientId }).onConflictDoNothing();
            const saved = await get(callback);
            if (!saved) throw new Error('Missing public client');
            return saved;
        },
    };
}
