import type { Hostname } from '@ptbk/protocol';

import { abortable } from './abortable';
import { callWithTimeout } from './call-with-timeout';
import type { Clock } from './clock';
import type { CnameLookup, DnsResolver } from './dns-resolver';
import type { Logger } from './logger';
import { createSingleFlight } from './single-flight';

export interface CachedDnsOptions {
    readonly inner: DnsResolver;
    readonly clock: Clock;
    readonly logger: Logger;
    /** `RELAY_REGISTRY_TTL_S`, so CNAMEs are re-checked at every registry refresh. */
    readonly ttlMs: number;
    /** How old a `cname` answer may be and still answer while the resolver fails (`RELAY_REGISTRY_MAX_STALE_S`). */
    readonly maxStaleMs: number;
    /** `RELAY_DNS_TIMEOUT_MS`; a slower answer counts as `error`. */
    readonly timeoutMs: number;
}

interface Answer {
    readonly lookup: Exclude<CnameLookup, { kind: 'error' }>;
    readonly answeredAtMs: number;
}

/**
 * A definite answer (`cname` or `none`) always replaces the cached one, so a customer repointing their domain away is
 * honoured at the next refresh. Only resolver failures fall back, and only to a `cname` younger than `maxStaleMs`.
 * Hostnames come from registry entries, so the cache is bounded by the registry.
 */
export function createCachedDnsResolver(options: CachedDnsOptions): DnsResolver {
    const { inner, clock, logger, ttlMs, maxStaleMs, timeoutMs } = options;
    const answers = new Map<Hostname, Answer>();
    const flights = createSingleFlight<Hostname, CnameLookup>();

    async function refresh(hostname: Hostname): Promise<CnameLookup> {
        const outcome = await callWithTimeout(clock, timeoutMs, (signal) => inner.resolveCname(hostname, signal));
        const nowMs = clock.nowMs();
        if (outcome.kind === 'done' && outcome.value.kind !== 'error') {
            answers.set(hostname, { lookup: outcome.value, answeredAtMs: nowMs });
            return outcome.value;
        }
        const reason = outcome.kind === 'done' ? 'error' : outcome.kind;
        const last = answers.get(hostname);
        if (last?.lookup.kind === 'cname' && nowMs - last.answeredAtMs < maxStaleMs) {
            logger.warn('dns.stale', { reason, ageS: Math.floor((nowMs - last.answeredAtMs) / 1000) });
            return last.lookup;
        }
        return { kind: 'error' };
    }

    return {
        resolveCname(hostname, signal) {
            if (signal.aborted) return Promise.reject(signal.reason as Error);
            const last = answers.get(hostname);
            if (last !== undefined && clock.nowMs() - last.answeredAtMs < ttlMs) return Promise.resolve(last.lookup);
            return abortable(
                flights.run(hostname, () => refresh(hostname)),
                signal,
            );
        },
    };
}
