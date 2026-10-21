import {
    defaultHostname,
    MAX_REGISTRY_HOSTNAMES,
    resolveRoutableHostnames,
    type EngineId,
    type Hostname,
    type RegistryEntry,
} from '@ptbk/protocol';

import type { Logger } from '../ports/logger';
import type { EngineHostnameStore } from './engine-hostname-store';
import type { RegistryReader } from './registry-reader';

export interface ReadRegistryEntryDeps {
    readonly registry: RegistryReader;
    readonly engineHostnames: EngineHostnameStore;
    readonly engineDomain: Hostname;
    readonly logger: Logger;
}

export type RegistryEntryOutcome =
    { readonly kind: 'found'; readonly entry: RegistryEntry } | { readonly kind: 'not-found' };

/**
 * C-03's registry entry for one engine: its key, its default hostname plus every custom hostname whose claim verifies
 * (through `resolveRoutableHostnames`, so a bad row is never served), and its status. Relays verify the claims again;
 * this only keeps the dashboard from handing out claims it cannot stand behind.
 */
export async function readRegistryEntry(
    deps: ReadRegistryEntryDeps,
    engineId: EngineId,
): Promise<RegistryEntryOutcome> {
    const record = await deps.registry.findEngine(engineId);
    if (record === null) {
        return { kind: 'not-found' };
    }
    const custom = (await deps.engineHostnames.activeCustomHostnames(engineId)).slice(0, MAX_REGISTRY_HOSTNAMES - 1);
    const candidate: RegistryEntry = {
        enginePublicKey: record.publicKey,
        hostnames: [defaultHostname(engineId, deps.engineDomain), ...custom.map((claim) => claim.hostname)],
        claims: [...custom],
        status: record.status,
    };
    const { hostnames, dropped } = resolveRoutableHostnames(engineId, candidate, deps.engineDomain);
    if (dropped.length > 0) {
        deps.logger.warn('registry.claims-dropped', { engineId, count: dropped.length });
    }
    const routable = new Set<Hostname>(hostnames);
    return {
        kind: 'found',
        entry: {
            ...candidate,
            hostnames: [...hostnames],
            claims: custom.filter((claim) => routable.has(claim.hostname)),
        },
    };
}
