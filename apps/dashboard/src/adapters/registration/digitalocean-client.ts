import { z } from 'zod';
import { readCapped } from '../read-capped';

export interface PublicClientStore {
    get(callback: string): Promise<string | null>;
    retain(callback: string, id: string): Promise<string>;
}

/** One public PKCE client per dashboard callback. Registration never creates a billable resource. */
export function digitalOceanClient(
    send: typeof fetch,
    store: PublicClientStore,
    callback: string,
    configured?: string,
) {
    return async (signal: AbortSignal): Promise<string> => {
        if (configured) return configured;
        const existing = await store.get(callback);
        if (existing) return existing;
        const endpoint = 'https://cloud.digitalocean.com/v1/oauth/register';
        const response = await send(endpoint, {
            method: 'POST',
            redirect: 'manual',
            signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_name: 'Promptbook',
                client_uri: new URL(callback).origin,
                redirect_uris: [callback],
                token_endpoint_auth_method: 'none',
                grant_types: ['authorization_code'],
                response_types: ['code'],
            }),
        });
        if (!response.ok) throw new Error('VPS authorization unavailable');
        const body = await readCapped(response, 8192);
        const data = z
            .object({
                client_id: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
                registration_access_token: z.string().min(1).max(1024),
            })
            .parse(JSON.parse(body ?? 'null') as unknown);
        const winner = await store.retain(callback, data.client_id);
        // Concurrent first requests may have registered an extra client. Only discard the losing registration.
        if (winner !== data.client_id)
            await send(endpoint + '/' + data.client_id, {
                method: 'DELETE',
                redirect: 'manual',
                signal: AbortSignal.timeout(5000),
                headers: { Authorization: 'Bearer ' + data.registration_access_token },
            }).catch(() => undefined);
        return winner;
    };
}
