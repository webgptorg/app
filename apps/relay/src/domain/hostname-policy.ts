import type { EngineId, Hostname, RegistryEntry } from '@ptbk/protocol';
import { defaultHostname, expectedCnameTarget, resolveRoutableHostnames } from '@ptbk/protocol';

import type { DnsResolver } from './dns-resolver';
import type { Logger } from './logger';

export interface RoutableHostnamesInput {
    readonly engineId: EngineId;
    readonly entry: RegistryEntry;
    readonly engineDomain: Hostname;
    /** The cached resolver, so revalidation re-checks CNAMEs at the registry's pace. */
    readonly dns: DnsResolver;
    readonly logger: Logger;
    readonly signal: AbortSignal;
}

/**
 * The hostnames the relay may route to this engine: the default hostname, then each custom hostname whose claim
 * verifies (C-03's `resolveRoutableHostnames`) and whose CNAME is exactly the engine's default hostname, so neither the
 * dashboard nor anyone else can attach a customer's domain to another engine (ADR 0014). Ignores `status`.
 */
export async function routableHostnames(input: RoutableHostnamesInput): Promise<readonly Hostname[]> {
    const { engineId, entry, engineDomain, dns, logger, signal } = input;
    const claimed = resolveRoutableHostnames(engineId, entry, engineDomain);
    if (claimed.dropped.length > 0) {
        logger.warn('hostname.claim-invalid', { engineId, dropped: claimed.dropped.length });
    }
    const ownDefault = defaultHostname(engineId, engineDomain);
    const expectedTarget = expectedCnameTarget(engineId, engineDomain);
    const checked = await Promise.all(
        claimed.hostnames.map(async (hostname) => {
            if (hostname === ownDefault) return true;
            const answer = await dns.resolveCname(hostname, signal);
            return answer.kind === 'cname' && answer.target === expectedTarget;
        }),
    );
    const routable = claimed.hostnames.filter((_, index) => checked[index] === true);
    const mismatched = claimed.hostnames.length - routable.length;
    if (mismatched > 0) logger.warn('hostname.dns-mismatch', { engineId, dropped: mismatched });
    return routable;
}
