import {
    defaultHostname,
    deriveEngineId,
    ed25519PublicKeyToBytes,
    verifyRegistration,
    type EngineId,
    type Hostname,
    type RegisterEngineRequest,
    type RegisterEngineResponse,
} from '@ptbk/protocol';

import { sha256Hex } from '../auth/secrets';
import type { Clock } from '../ports/clock';
import type { Logger } from '../ports/logger';
import type { EngineCreationPolicy } from './engine-creation-policy';
import type { EngineStore } from './engine-store';
import type { LinkCodeStore } from './link-code-store';

export interface RegisterEngineDeps {
    readonly linkCodes: Pick<LinkCodeStore, 'findRedeemable' | 'redeemForNewEngine' | 'redeemForExistingEngine'>;
    readonly engines: Pick<EngineStore, 'findForRegistration'>;
    readonly policy: Pick<EngineCreationPolicy, 'checkRegistration'>;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly engineDomain: Hostname;
    /** Every relay's hostname, in configuration order; the engine dials them all (D-01's `relays`). */
    readonly relays: readonly Hostname[];
}

export type RegisterOutcome =
    | { readonly kind: 'registered'; readonly response: RegisterEngineResponse }
    /** One outcome for an unknown, expired and used code, so registration is no oracle for codes. */
    | { readonly kind: 'invalid-link-code' }
    | { readonly kind: 'bad-signature' }
    /** Suspended by a platform admin or revoked by its owner. */
    | { readonly kind: 'engine-suspended' }
    /** The key's engine ID belongs to another organization; the code stays unused. */
    | { readonly kind: 'engine-exists' }
    | { readonly kind: 'not-entitled' }
    | { readonly kind: 'engine-limit' };

/** A lost race is retried once against fresh state: the winner's engine or used code then answers properly. */
const ATTEMPTS = 2;

function registered(deps: RegisterEngineDeps, engineId: EngineId, hostname: Hostname): RegisterOutcome {
    return { kind: 'registered', response: { engineId, hostname, relays: [...deps.relays] } };
}

async function attempt(
    deps: RegisterEngineDeps,
    request: RegisterEngineRequest,
    engineId: EngineId,
    codeHash: string,
    signal: AbortSignal,
): Promise<RegisterOutcome | 'conflict'> {
    const now = deps.clock.nowMs();
    const orgId = await deps.linkCodes.findRedeemable(codeHash, now);
    if (orgId === null) {
        return { kind: 'invalid-link-code' };
    }
    const existing = await deps.engines.findForRegistration(engineId);
    if (existing !== null) {
        if (existing.status === 'suspended') {
            return { kind: 'engine-suspended' };
        }
        if (existing.orgId !== orgId) {
            return { kind: 'engine-exists' };
        }
        // The signature proves the key and the code proves the organization's intent: an engine that lost its local
        // registration but kept its key re-links, and its signed version and mode replace the stored ones.
        const refreshed = await deps.linkCodes.redeemForExistingEngine(codeHash, {
            engineId,
            orgId,
            mode: request.mode,
            engineVersion: request.engineVersion,
            now,
        });
        return refreshed === 'redeemed' ? registered(deps, engineId, existing.hostname) : 'conflict';
    }
    const decision = await deps.policy.checkRegistration(orgId, signal);
    if (decision.kind === 'denied') {
        return { kind: decision.reason };
    }
    const hostname = defaultHostname(engineId, deps.engineDomain);
    const created = await deps.linkCodes.redeemForNewEngine(codeHash, {
        engineId,
        orgId,
        publicKey: request.enginePublicKey,
        hostname,
        mode: request.mode,
        engineVersion: request.engineVersion,
        status: 'active',
        statusReason: null,
        createdAt: now,
        updatedAt: now,
    });
    return created === 'redeemed' ? registered(deps, engineId, hostname) : 'conflict';
}

async function resolve(deps: RegisterEngineDeps, request: RegisterEngineRequest, signal: AbortSignal) {
    // Proof of key possession comes before anything reads the link code, so a stolen code alone learns nothing.
    if (!verifyRegistration(request)) {
        return { outcome: { kind: 'bad-signature' } as const, engineId: null };
    }
    const engineId = await deriveEngineId(ed25519PublicKeyToBytes(request.enginePublicKey));
    const codeHash = await sha256Hex(request.linkCode);
    for (let attempts = 1; ; attempts++) {
        const outcome = await attempt(deps, request, engineId, codeHash, signal);
        if (outcome !== 'conflict') {
            return { outcome, engineId };
        }
        if (attempts === ATTEMPTS) {
            return { outcome: { kind: 'invalid-link-code' } as const, engineId };
        }
    }
}

/**
 * C-03's registration (spec, Pairing and identity): links the engine whose key signed the request to the link code's
 * organization. Logs the engine ID and the outcome only, never the code or its hash.
 */
export async function registerEngine(
    deps: RegisterEngineDeps,
    request: RegisterEngineRequest,
    signal: AbortSignal,
): Promise<RegisterOutcome> {
    const { outcome, engineId } = await resolve(deps, request, signal);
    deps.logger.info('engine.registration', {
        outcome: outcome.kind,
        ...(engineId === null ? {} : { engineId }),
    });
    return outcome;
}
