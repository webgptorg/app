import type { Hostname } from '@ptbk/protocol';

import type { CnameLookup, DnsResolver } from '../domain/dns-resolver';

/** A port-level answer, or `throw` and `hang` (waits for the abort) to simulate a broken resolver. */
export type InMemoryDnsAnswer = CnameLookup | { readonly kind: 'throw' } | { readonly kind: 'hang' };

export interface InMemoryDnsResolver extends DnsResolver {
    /** Hostnames without an answer resolve to `none`. */
    setAnswer(hostname: Hostname, answer: InMemoryDnsAnswer): void;
    /** Queries per hostname, including failed ones. */
    queries(hostname: Hostname): number;
    totalQueries(): number;
}

export function createInMemoryDnsResolver(): InMemoryDnsResolver {
    const answers = new Map<Hostname, InMemoryDnsAnswer>();
    const counts = new Map<Hostname, number>();
    return {
        resolveCname(hostname, signal): Promise<CnameLookup> {
            counts.set(hostname, (counts.get(hostname) ?? 0) + 1);
            if (signal.aborted) return Promise.reject(signal.reason as Error);
            const answer = answers.get(hostname) ?? { kind: 'none' };
            switch (answer.kind) {
                case 'throw':
                    return Promise.reject(new Error('resolver failure'));
                case 'hang':
                    return new Promise((_, reject) => {
                        signal.addEventListener(
                            'abort',
                            () => {
                                reject(signal.reason as Error);
                            },
                            { once: true },
                        );
                    });
                case 'cname':
                case 'none':
                case 'error':
                    return Promise.resolve(answer);
            }
        },
        setAnswer(hostname, answer) {
            answers.set(hostname, answer);
        },
        queries: (hostname) => counts.get(hostname) ?? 0,
        totalQueries: () => [...counts.values()].reduce((sum, count) => sum + count, 0),
    };
}
