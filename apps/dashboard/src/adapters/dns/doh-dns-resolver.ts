import { Hostname } from '@ptbk/protocol';
import { z } from 'zod';

import type { CnameLookup, DnsResolver } from '../../domain/ports/dns-resolver';

export const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
export const DOH_TIMEOUT_MS = 3000;

const CNAME_RECORD = 5;
const NOERROR = 0;
const NXDOMAIN = 3;
// A CNAME answer is a few hundred bytes; anything far larger is not one.
const MAX_RESPONSE_CHARS = 64 * 1024;

// Read tolerantly: the resolver's other fields (flags, the question, comments) are stripped.
const answerSchema = z.object({ name: z.string().max(512), type: z.number().int(), data: z.string().max(512) });
const responseSchema = z.object({ Status: z.number().int(), Answer: z.array(answerSchema).max(64).optional() });

const ERROR: CnameLookup = { kind: 'error' };
const NONE: CnameLookup = { kind: 'none' };

function bare(name: string): string {
    return name.toLowerCase().replace(/\.$/, '');
}

function toLookup(hostname: Hostname, text: string): CnameLookup {
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return ERROR;
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
        return ERROR;
    }
    if (parsed.data.Status === NXDOMAIN) {
        return NONE;
    }
    if (parsed.data.Status !== NOERROR) {
        return ERROR;
    }
    const records = (parsed.data.Answer ?? []).filter(
        (answer) => answer.type === CNAME_RECORD && bare(answer.name) === hostname,
    );
    const [record] = records;
    if (records.length !== 1 || record === undefined) {
        return NONE;
    }
    const target = Hostname.safeParse(bare(record.data));
    return target.success ? { kind: 'cname', target: target.data } : NONE;
}

/**
 * DNS over HTTPS with the JSON API (`application/dns-json`), answering like the relay's resolver (R-02): exactly one
 * CNAME record at the name is `cname`, no record or NXDOMAIN is `none`, anything else is `error`.
 */
export function createDohDnsResolver(deps: {
    readonly fetch: typeof fetch;
    readonly endpoint?: string;
    readonly timeoutMs?: number;
}): DnsResolver {
    const endpoint = deps.endpoint ?? DOH_ENDPOINT;
    const timeoutMs = deps.timeoutMs ?? DOH_TIMEOUT_MS;
    return {
        async resolveCname(hostname, signal) {
            signal.throwIfAborted();
            const query = new URLSearchParams({ name: hostname, type: 'CNAME' });
            try {
                const response = await deps.fetch(`${endpoint}?${query.toString()}`, {
                    headers: { accept: 'application/dns-json' },
                    // A redirect is an answer we did not ask for: `manual` hands back the 3xx, which is not `ok`.
                    redirect: 'manual',
                    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
                });
                if (!response.ok) {
                    return ERROR;
                }
                const text = await response.text();
                return text.length > MAX_RESPONSE_CHARS ? ERROR : toLookup(hostname, text);
            } catch {
                signal.throwIfAborted();
                return ERROR;
            }
        },
    };
}
