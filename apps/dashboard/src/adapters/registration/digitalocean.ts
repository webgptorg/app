import { z } from 'zod';
import { cloudInit } from '../../domain/registration/cloud-init';
import { sha256Hex } from '../../domain/auth/secrets';
import type { VpsProvider } from '../../domain/registration/vps-provider';
import { DIGITALOCEAN, VPS_CALLBACK } from '../../shared/vps';
import { readCapped } from '../read-capped';

const oauth = 'https://cloud.digitalocean.com/v1/oauth';
const api = 'https://api.digitalocean.com/v2';
const grantSchema = z.object({
    access_token: z.string().min(1).max(1024),
    info: z.object({ uuid: z.uuid(), team_uuid: z.uuid() }),
});
const size = z.object({
    slug: z.string(),
    available: z.boolean(),
    price_monthly: z.number().positive(),
    price_hourly: z.number().positive(),
    regions: z.array(z.string()),
});

async function json(response: Response): Promise<unknown> {
    const body = await readCapped(response, 512 * 1024);
    if (body === null) throw new Error('Oversized provider response');
    return JSON.parse(body) as unknown;
}

export function digitalOceanProvider(
    send: typeof fetch,
    origin: string,
    clientId: (signal: AbortSignal) => Promise<string>,
): VpsProvider {
    const request = (url: string, init: RequestInit, signal?: AbortSignal) =>
        send(url, {
            ...init,
            redirect: 'manual',
            signal: AbortSignal.any([AbortSignal.timeout(8_000), ...(signal ? [signal] : [])]),
        });
    const bearer = (token: string) => ({ Authorization: 'Bearer ' + token });
    return {
        clientId,
        async authorize(code, verifier, signal) {
            const response = await request(
                oauth + '/token',
                {
                    method: 'POST',
                    body: new URLSearchParams({
                        client_id: await clientId(signal),
                        redirect_uri: origin + VPS_CALLBACK,
                        grant_type: 'authorization_code',
                        code,
                        code_verifier: verifier,
                    }),
                },
                signal,
            );
            if (!response.ok) throw new Error('Provider authorization failed');
            const grant = grantSchema.parse(await json(response));
            return {
                token: grant.access_token,
                ownerDigest: await sha256Hex(grant.info.uuid.toLowerCase() + '/' + grant.info.team_uuid.toLowerCase()),
            };
        },
        async checkPrice(grant, signal) {
            const response = await request(api + '/sizes?per_page=200', { headers: bearer(grant.token) }, signal);
            if (!response.ok) return false;
            const sizes = z.object({ sizes: z.array(size).max(200) }).parse(await json(response)).sizes;
            return sizes.some(
                (s) =>
                    s.slug === DIGITALOCEAN.size &&
                    s.available &&
                    s.regions.includes(DIGITALOCEAN.region) &&
                    s.price_monthly <= DIGITALOCEAN.monthlyUsd &&
                    s.price_hourly <= DIGITALOCEAN.hourlyUsd,
            );
        },
        bootstrap: (release, code, grant) => cloudInit(release, origin, code, grant.ownerDigest),
        async create(grant, name, userData) {
            // Once dispatched, a timeout (including a dropped response) can mean a paid Droplet exists.
            try {
                const response = await request(api + '/droplets', {
                    method: 'POST',
                    headers: { ...bearer(grant.token), 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name,
                        image: DIGITALOCEAN.image,
                        size: DIGITALOCEAN.size,
                        region: DIGITALOCEAN.region,
                        backups: false,
                        user_data: userData,
                    }),
                });
                if ([400, 401, 403, 404, 422, 429].includes(response.status)) return { kind: 'rejected' };
                if (response.status !== 202) return { kind: 'unknown' };
                const { droplet } = z
                    .object({ droplet: z.object({ id: z.number().int().positive() }) })
                    .parse(await json(response));
                return { kind: 'created', resourceId: String(droplet.id) };
            } catch {
                return { kind: 'unknown' };
            }
        },
        async revoke(grant) {
            await request(oauth + '/revoke', {
                method: 'POST',
                headers: bearer(grant.token),
                body: new URLSearchParams({ token: grant.token }),
            });
        },
    };
}
