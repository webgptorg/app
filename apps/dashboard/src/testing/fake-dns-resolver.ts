import type { Hostname } from '@ptbk/protocol';

import type { CnameLookup, DnsResolver } from '../domain/ports/dns-resolver';

export interface FakeDnsResolver extends DnsResolver {
    setAnswer(hostname: Hostname, answer: CnameLookup): void;
    /** How many times `hostname` was looked up. */
    queries(hostname: Hostname): number;
}

/** Answers `none` for every name it was not told about. */
export function createFakeDnsResolver(): FakeDnsResolver {
    const answers = new Map<Hostname, CnameLookup>();
    const counts = new Map<Hostname, number>();
    return {
        setAnswer(hostname, answer) {
            answers.set(hostname, answer);
        },
        queries: (hostname) => counts.get(hostname) ?? 0,
        resolveCname(hostname, signal) {
            signal.throwIfAborted();
            counts.set(hostname, (counts.get(hostname) ?? 0) + 1);
            return Promise.resolve(answers.get(hostname) ?? { kind: 'none' });
        },
    };
}
