import { Resolver } from 'node:dns/promises';

import { Hostname } from '@ptbk/protocol';

import type { CnameLookup, DnsResolver } from '../domain/dns-resolver';

export interface NodeDnsResolverOptions {
    /** `RELAY_DNS_SERVERS`; `null` uses the system resolvers. Entries may carry a port (`127.0.0.1:5353`). */
    readonly servers: readonly string[] | null;
    readonly timeoutMs: number;
}

// The name has no records of this type, or does not exist (NXDOMAIN): a definite "no CNAME".
const NO_RECORD = new Set(['ENODATA', 'ENOTFOUND']);

function toLookup(records: readonly string[]): CnameLookup {
    const [record] = records;
    if (records.length !== 1 || record === undefined) return { kind: 'none' };
    const target = Hostname.safeParse(record.replace(/\.$/, ''));
    return target.success ? { kind: 'cname', target: target.data } : { kind: 'none' };
}

/** c-ares through `dns.promises.Resolver`, one resolver per query so cancelling one never cancels another. */
export function createNodeDnsResolver(options: NodeDnsResolverOptions): DnsResolver {
    const { servers, timeoutMs } = options;
    return {
        async resolveCname(hostname, signal) {
            signal.throwIfAborted();
            const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
            if (servers !== null) resolver.setServers(servers);
            const cancel = (): void => {
                resolver.cancel();
            };
            signal.addEventListener('abort', cancel, { once: true });
            try {
                return toLookup(await resolver.resolveCname(hostname));
            } catch (error) {
                signal.throwIfAborted();
                const code = (error as NodeJS.ErrnoException).code;
                return code !== undefined && NO_RECORD.has(code) ? { kind: 'none' } : { kind: 'error' };
            } finally {
                signal.removeEventListener('abort', cancel);
            }
        },
    };
}
