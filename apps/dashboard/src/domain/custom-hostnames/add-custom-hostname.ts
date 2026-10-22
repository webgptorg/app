import {
    defaultHostname,
    MAX_REGISTRY_HOSTNAMES,
    resolveRoutableHostnames,
    type Ed25519Signature,
    type EngineId,
    type Hostname,
} from '@ptbk/protocol';

import type { UserId } from '../ids';
import type { Clock } from '../ports/clock';
import type { Random } from '../ports/random';
import type { CustomHostnameRecord, CustomHostnameStore } from './custom-hostname-store';
import { hostnameAuditEntry } from './hostname-audit';
import { isUnderAny, normaliseCustomHostname } from './normalise-hostname';

/** The registry entry holds the default hostname and at most this many custom ones; more would never route. */
export const MAX_CUSTOM_HOSTNAMES = MAX_REGISTRY_HOSTNAMES - 1;

export interface AddCustomHostnameDeps {
    readonly customHostnames: Pick<CustomHostnameStore, 'findEngine' | 'listForEngine' | 'isAssigned' | 'insert'>;
    readonly clock: Clock;
    readonly random: Random;
    readonly engineDomain: Hostname;
    /** Domains no customer may claim a name in, with everything under them: ours, the engine domain, the relays. */
    readonly reservedDomains: readonly Hostname[];
}

export interface AddCustomHostnameInput {
    readonly engineId: EngineId;
    /** As the admin typed it; normalised here. */
    readonly hostname: string;
    readonly claimSig: Ed25519Signature;
    readonly adminUserId: UserId;
}

export type AddCustomHostnameOutcome =
    | { readonly kind: 'added'; readonly record: CustomHostnameRecord }
    | { readonly kind: 'invalid-hostname' }
    | { readonly kind: 'reserved-domain' }
    | { readonly kind: 'taken' }
    | { readonly kind: 'bad-claim' }
    | { readonly kind: 'engine-not-found' }
    | { readonly kind: 'limit-reached' };

/**
 * Attaches a customer's hostname to an engine as `pending-dns`. The claim goes through C-03's
 * `resolveRoutableHostnames`, the check relays run on every registry read, so nothing is stored that the registry
 * would drop. Routing also needs the CNAME (`checkCustomHostname`), which relays verify again on their own.
 */
export async function addCustomHostname(
    deps: AddCustomHostnameDeps,
    input: AddCustomHostnameInput,
): Promise<AddCustomHostnameOutcome> {
    const hostname = normaliseCustomHostname(input.hostname);
    if (hostname === null) {
        return { kind: 'invalid-hostname' };
    }
    if (isUnderAny(hostname, deps.reservedDomains)) {
        return { kind: 'reserved-domain' };
    }
    const engine = await deps.customHostnames.findEngine(input.engineId);
    if (engine === null) {
        return { kind: 'engine-not-found' };
    }
    if (await deps.customHostnames.isAssigned(hostname)) {
        return { kind: 'taken' };
    }
    const claim = { hostname, sig: input.claimSig };
    const { hostnames } = resolveRoutableHostnames(
        input.engineId,
        {
            enginePublicKey: engine.publicKey,
            hostnames: [defaultHostname(input.engineId, deps.engineDomain), hostname],
            claims: [claim],
            status: 'active',
        },
        deps.engineDomain,
    );
    if (!hostnames.includes(hostname)) {
        return { kind: 'bad-claim' };
    }
    if ((await deps.customHostnames.listForEngine(input.engineId)).length >= MAX_CUSTOM_HOSTNAMES) {
        return { kind: 'limit-reached' };
    }
    const record: CustomHostnameRecord = {
        hostname,
        engineId: input.engineId,
        orgId: engine.orgId,
        claimSig: input.claimSig,
        status: 'pending-dns',
        dnsCheckedAt: null,
        createdAt: deps.clock.nowMs(),
        createdByUserId: input.adminUserId,
    };
    const audit = hostnameAuditEntry(deps, input.adminUserId, 'engine.hostname.add', input.engineId, hostname);
    const inserted = await deps.customHostnames.insert(record, audit);
    return inserted === 'inserted' ? { kind: 'added', record } : { kind: 'taken' };
}
