import type { Hostname } from '@ptbk/protocol';

/**
 * `cname`: exactly one CNAME record, its target lowercased without the trailing dot. `none`: no record, NXDOMAIN or
 * several records. `error`: the resolver could not answer (timeout, server failure).
 */
export type CnameLookup =
    { readonly kind: 'cname'; readonly target: Hostname } | { readonly kind: 'none' } | { readonly kind: 'error' };

export interface DnsResolver {
    /** Rejects with `signal.reason` once `signal` aborts. */
    resolveCname(hostname: Hostname, signal: AbortSignal): Promise<CnameLookup>;
}
