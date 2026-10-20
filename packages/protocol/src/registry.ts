import { z } from 'zod';

import { engineIdFromDefaultHostname, defaultHostname } from './engine-id';
import { verifyHostnameClaim } from './hostname-claim';
import type { EngineId } from './ids';
import { Ed25519PublicKey, Ed25519Signature, Hostname, ed25519PublicKeyToBytes, ed25519SignatureToBytes } from './ids';

export const REGISTRY_ENTRY_MAX_BYTES = 65_536;
export const MAX_REGISTRY_HOSTNAMES = 32;

const claimShape = { hostname: Hostname, sig: Ed25519Signature };

/** The engine's signature over `signingInput('ptbk-hostname-v1', hostname, engineId)` (see `signHostnameClaim`). */
export const HostnameClaim = z.strictObject(claimShape);
export type HostnameClaim = z.infer<typeof HostnameClaim>;

const RegistryStatus = z.enum(['active', 'suspended']);

const entryShape = {
    enginePublicKey: Ed25519PublicKey,
    hostnames: z.array(Hostname).max(MAX_REGISTRY_HOSTNAMES),
    status: RegistryStatus,
};

/**
 * As the dashboard serves it. Duplicates are not a schema error: `resolveRoutableHostnames` drops them, so one bad
 * hostname cannot take the engine's default hostname offline.
 */
export const RegistryEntry = z.strictObject({
    ...entryShape,
    claims: z.array(HostnameClaim).max(MAX_REGISTRY_HOSTNAMES),
});
export type RegistryEntry = z.infer<typeof RegistryEntry>;

/** What the relay parses the registry response with: known fields validated, unknown ones stripped (ADR 0010 §3). */
export const TolerantRegistryEntry = z.object({
    ...entryShape,
    claims: z.array(z.object(claimShape)).max(MAX_REGISTRY_HOSTNAMES),
});

export function registryPath(engineId: EngineId): string {
    return `/internal/v1/engines/${engineId}`;
}

export interface RoutableHostnames {
    /** The default hostname first, then every custom hostname with exactly one verifying claim, in entry order. */
    readonly hostnames: readonly Hostname[];
    /** Every other hostname in the entry, once each. */
    readonly dropped: readonly Hostname[];
}

/**
 * The single implementation of claim verification, used by the relay on every registry read and by the dashboard
 * before storing or serving a claim. The default hostname needs no claim: it is derived from the key. A custom
 * hostname is kept only if it lies outside the engine domain, appears once in `hostnames`, and has exactly one claim
 * that verifies against the entry's key and this engine ID; a hostname listed or claimed twice routes nowhere, as
 * conflicting claims between engines do (ADR 0014). Necessary but not sufficient for routing: the relay also checks
 * the CNAME (`expectedCnameTarget`). Ignores `status`; the caller refuses suspended engines.
 */
export function resolveRoutableHostnames(
    engineId: EngineId,
    entry: RegistryEntry,
    engineDomain: Hostname,
): RoutableHostnames {
    const ownDefault = defaultHostname(engineId, engineDomain);
    const publicKey = ed25519PublicKeyToBytes(entry.enginePublicKey);
    const listed = countOf(entry.hostnames);
    const hostnames: Hostname[] = [ownDefault];
    const dropped: Hostname[] = [];
    for (const [hostname, count] of listed) {
        if (hostname === ownDefault) continue;
        const claims = entry.claims.filter((candidate) => candidate.hostname === hostname);
        const claim = claims.length === 1 ? claims[0] : undefined;
        const routable =
            count === 1 &&
            claim !== undefined &&
            engineIdFromDefaultHostname(hostname, engineDomain).kind === 'custom' &&
            verifyHostnameClaim(publicKey, hostname, engineId, ed25519SignatureToBytes(claim.sig));
        (routable ? hostnames : dropped).push(hostname);
    }
    return { hostnames, dropped };
}

function countOf(values: readonly Hostname[]): Map<Hostname, number> {
    const counts = new Map<Hostname, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return counts;
}
