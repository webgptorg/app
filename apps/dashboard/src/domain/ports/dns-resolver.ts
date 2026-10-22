import type { Hostname } from '@ptbk/protocol';

/**
 * The relay's answer shape (R-02): `cname` is exactly one CNAME record, its target lowercased without the trailing
 * dot; `none` is no record or NXDOMAIN; `error` is anything else (timeout, SERVFAIL, an unreadable answer), which says
 * nothing about the record.
 */
export type CnameLookup =
    { readonly kind: 'cname'; readonly target: Hostname } | { readonly kind: 'none' } | { readonly kind: 'error' };

export interface DnsResolver {
    /** Rejects with `signal.reason` once `signal` aborts; every other failure is `error`. */
    resolveCname(hostname: Hostname, signal: AbortSignal): Promise<CnameLookup>;
}
