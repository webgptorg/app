import { z } from 'zod';
import { VPS_CALLBACK, providerId, type CloudOffer } from '../../../shared/vps';
import { VPS_PROVIDERS } from '../../../shared/vps-catalog';

const key = 'ptbk.vps.authorization';
const transaction = z.object({
    provider: providerId,
    link: z.string().regex(/^[a-z2-7]{26}$/),
    org: z.string(),
    state: z.string().length(43),
    verifier: z.string().length(43),
    expires: z.number(),
    code: z.string().min(1).max(512).optional(),
});
export type VpsTransaction = z.infer<typeof transaction>;

function base64Url(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replaceAll('=', '');
}

export async function beginVps(
    offer: CloudOffer,
    clientId: string,
    org: string,
    link: string,
    origin: string,
    storage: Storage,
): Promise<string> {
    const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    storage.setItem(
        key,
        JSON.stringify({ provider: offer.provider, org, link, verifier, state, expires: Date.now() + 60 * 60_000 }),
    );
    const url = new URL(VPS_PROVIDERS[offer.provider].authorize);
    url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: origin + VPS_CALLBACK,
        response_type: 'code',
        scope: VPS_PROVIDERS[offer.provider].scopes,
        state,
        code_challenge_method: 'S256',
        code_challenge: base64Url(
            new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
        ),
    }).toString();
    return url.href;
}

/** A callback may be replayed by navigation, but only this tab can confirm its own live grant. */
export function resumeVps(search: URLSearchParams, org: string, storage: Storage): VpsTransaction | null {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const attempt = transaction.parse(JSON.parse(raw) as unknown);
    if (attempt.org !== org || attempt.expires <= Date.now()) return null;
    if (!search.size) return attempt;
    if (search.getAll('state').length !== 1 || search.get('state') !== attempt.state) return null;
    const code = search.get('code');
    if (search.has('error') || !code || code.length > 512 || search.getAll('code').length !== 1) {
        const denied = { ...attempt, code: undefined };
        storage.setItem(key, JSON.stringify(denied));
        return denied;
    }
    const result = { ...attempt, code };
    storage.setItem(key, JSON.stringify(result));
    return result;
}

export function clearVps(storage: Storage): void {
    storage.removeItem(key);
}
