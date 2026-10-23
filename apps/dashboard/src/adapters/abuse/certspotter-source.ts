import { z } from 'zod';

import type { CtIssuance, CtLogSource } from '../../domain/abuse/ct-log-source';
import { readCapped } from '../read-capped';
import { CtSourceError } from './ct-source-error';

const MAX_PAGE_BYTES = 4 * 1024 * 1024;
/** A first run catches up over several runs rather than spending the Worker's subrequests in one. */
export const CERTSPOTTER_MAX_PAGES = 10;

/** The fields we read of an issuance (`expand=dns_names&expand=issuer`); anything else is ignored. */
const issuanceSchema = z.object({
    id: z.string().regex(/^\d{1,20}$/),
    dns_names: z.array(z.string().max(1024)).max(1000),
    issuer: z.object({ name: z.string().max(1024) }),
    not_before: z.iso.datetime({ offset: true }),
});

/**
 * Cert Spotter's issuances API, paged with `after`; the cursor is the last issuance ID handled. Without an API key it
 * answers a limited number of queries per hour, enough for a run every 15 minutes.
 */
export function createCertSpotterSource(deps: {
    readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
    readonly userAgent: string;
    /** `CERTSPOTTER_API_KEY`, optional. */
    readonly apiKey: string | null;
}): CtLogSource {
    async function page(domain: string, after: string | null, signal: AbortSignal) {
        const query = new URLSearchParams({ domain, include_subdomains: 'true' });
        query.append('expand', 'dns_names');
        query.append('expand', 'issuer');
        if (after !== null) query.set('after', after);
        const response = await deps.fetch(`https://api.certspotter.com/v1/issuances?${query.toString()}`, {
            headers: {
                Accept: 'application/json',
                'User-Agent': deps.userAgent,
                ...(deps.apiKey === null ? {} : { Authorization: `Bearer ${deps.apiKey}` }),
            },
            redirect: 'error',
            signal,
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new CtSourceError(`Cert Spotter answered ${String(response.status)}`);
        }
        const text = await readCapped(response, MAX_PAGE_BYTES);
        if (text === null) throw new CtSourceError('Cert Spotter answered too much');
        const parsed = z.array(issuanceSchema).safeParse(JSON.parse(text));
        if (!parsed.success) throw new CtSourceError('Cert Spotter sent an unexpected shape');
        return parsed.data;
    }

    return {
        name: 'certspotter',
        async read(domain, cursor, signal) {
            const issuances: CtIssuance[] = [];
            let after = cursor;
            for (let pages = 0; pages < CERTSPOTTER_MAX_PAGES; pages++) {
                const items = await page(domain, after, signal);
                if (items.length === 0) break;
                for (const item of items) {
                    issuances.push({
                        hostnames: [...new Set(item.dns_names.map((name) => name.trim().toLowerCase()))],
                        issuer: item.issuer.name,
                        notBefore: Date.parse(item.not_before),
                    });
                }
                after = items.at(-1)?.id ?? after;
            }
            return { issuances, cursor: after };
        },
    };
}
