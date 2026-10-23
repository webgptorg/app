import { z } from 'zod';

import type { CtIssuance, CtLogSource } from '../../domain/abuse/ct-log-source';
import { readCapped } from '../read-capped';
import { CtSourceError } from './ct-source-error';

/** Every unexpired certificate of a busy engine domain fits; crt.sh pages nothing. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** The fields we read of crt.sh's JSON; anything else it sends is ignored. */
const entrySchema = z.object({
    id: z.int().positive(),
    issuer_name: z.string().max(1024),
    common_name: z.string().max(1024).nullable().optional(),
    name_value: z.string().max(256 * 1024),
    not_before: z.string().max(64),
});

/** crt.sh writes UTC times without a zone. */
function utc(timestamp: string): number {
    const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(timestamp) ? timestamp : `${timestamp}Z`);
    if (Number.isNaN(ms)) throw new CtSourceError('crt.sh sent an invalid not_before');
    return ms;
}

/**
 * crt.sh's JSON search for every unexpired certificate under the domain. It has no paging or "since", so the cursor is
 * the largest crt.sh ID handled, and anything at or below it is skipped.
 */
export function createCrtShSource(deps: {
    readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
    readonly userAgent: string;
}): CtLogSource {
    return {
        name: 'crt.sh',
        async read(domain, cursor, signal) {
            const query = new URLSearchParams({ q: `%.${domain}`, output: 'json', exclude: 'expired' });
            const response = await deps.fetch(`https://crt.sh/?${query.toString()}`, {
                headers: { Accept: 'application/json', 'User-Agent': deps.userAgent },
                redirect: 'error',
                signal,
            });
            if (!response.ok) {
                await response.body?.cancel();
                throw new CtSourceError(`crt.sh answered ${String(response.status)}`);
            }
            const text = await readCapped(response, MAX_BODY_BYTES);
            if (text === null) throw new CtSourceError('crt.sh answered too much');
            const parsed = z.array(entrySchema).safeParse(JSON.parse(text));
            if (!parsed.success) throw new CtSourceError('crt.sh sent an unexpected shape');
            const after = cursor === null ? 0 : Number(cursor);
            const fresh = parsed.data.filter((entry) => entry.id > after);
            const issuances = fresh.map((entry): CtIssuance => ({
                hostnames: [
                    ...new Set(
                        [...entry.name_value.split('\n'), entry.common_name ?? '']
                            .map((name) => name.trim().toLowerCase())
                            .filter((name) => name !== ''),
                    ),
                ],
                issuer: entry.issuer_name,
                notBefore: utc(entry.not_before),
            }));
            const newest = Math.max(after, ...fresh.map((entry) => entry.id));
            return { issuances, cursor: newest === 0 ? cursor : String(newest) };
        },
    };
}
