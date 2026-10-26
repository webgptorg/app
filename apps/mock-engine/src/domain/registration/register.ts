import type { EngineVersion, Hostname, LinkCode, RegistrationErrorCode } from '@ptbk/protocol';
import { REGISTRATION_ERROR_CODE, checkRegistrationResponse, signRegistration } from '@ptbk/protocol';

import type { DashboardApi } from '../dashboard/dashboard-api';
import type { EngineIdentity } from '../identity/engine-identity';
import { signerOf } from '../identity/engine-identity';
import type { Logger } from '../logger';
import type { Registration, RegistrationStore } from './registration';

export type RegistrationOutcome =
    | { readonly kind: 'registered'; readonly registration: Registration }
    | { readonly kind: 'already-registered'; readonly registration: Registration }
    | { readonly kind: 'rejected'; readonly reason: RegistrationErrorCode }
    | {
          readonly kind: 'refused-response';
          readonly reason: 'engine-id-mismatch' | 'hostname-mismatch' | 'invalid';
      }
    | { readonly kind: 'unavailable' };

/** A stored registration this engine cannot use. Messages name the mismatch, never stored values. */
export class StoredRegistrationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StoredRegistrationError';
    }
}

export interface StoredRegistrationDeps {
    readonly store: RegistrationStore;
    readonly identity: EngineIdentity;
    readonly dashboardUrl: string;
    readonly engineDomain: Hostname;
}

export interface RegisterEngineDeps extends StoredRegistrationDeps {
    readonly api: DashboardApi;
    readonly engineVersion: EngineVersion;
    /** Used for this one request and never stored or logged. */
    readonly linkCode: LinkCode;
    readonly logger: Logger;
    readonly signal: AbortSignal;
}

const REJECTIONS: ReadonlySet<string> = new Set(Object.values(REGISTRATION_ERROR_CODE));

function isRejection(code: string): code is RegistrationErrorCode {
    return REJECTIONS.has(code);
}

/**
 * The stored registration, checked against this engine's key and configuration as if the dashboard had just sent
 * it: a key file swapped under a kept `registration.json`, or another engine domain or dashboard, stops startup.
 */
export async function loadRegistration(deps: StoredRegistrationDeps): Promise<Registration | null> {
    const stored = await deps.store.load();
    if (stored === null) return null;
    if (stored.dashboardUrl !== deps.dashboardUrl) {
        throw new StoredRegistrationError('the stored registration is for another dashboard than PTBK_DASHBOARD_URL');
    }
    const check = await checkRegistrationResponse(
        { engineId: stored.engineId, hostname: stored.hostname, relays: [...stored.relays] },
        deps.identity.publicKey,
        deps.engineDomain,
    );
    switch (check.kind) {
        case 'ok':
            return stored;
        case 'engine-id-mismatch':
            throw new StoredRegistrationError('the stored registration belongs to another engine key');
        case 'hostname-mismatch':
            throw new StoredRegistrationError('the stored registration is for another PTBK_ENGINE_DOMAIN');
    }
}

/**
 * Registers once with a link code (spec, Pairing and identity). An engine that already holds a registration makes no
 * network call. The dashboard's answer is checked with `checkRegistrationResponse`, so an identity the engine's own
 * key does not derive is refused, and only then stored. Re-registering a kept key with a fresh code is idempotent on
 * the dashboard and comes back as `registered` with the same engine ID.
 */
export async function registerEngine(deps: RegisterEngineDeps): Promise<RegistrationOutcome> {
    const existing = await loadRegistration(deps);
    if (existing !== null) return { kind: 'already-registered', registration: existing };
    const request = await signRegistration(
        signerOf(deps.identity),
        { linkCode: deps.linkCode, engineVersion: deps.engineVersion, mode: 'tunnel' },
        deps.signal,
    );
    const call = await deps.api.register(request, deps.signal);
    switch (call.kind) {
        case 'unavailable':
            deps.logger.warn('registration.unavailable', call.status === null ? {} : { status: call.status });
            return { kind: 'unavailable' };
        case 'invalid-response':
            return { kind: 'refused-response', reason: 'invalid' };
        case 'problem':
            if (isRejection(call.problem.code)) return { kind: 'rejected', reason: call.problem.code };
            // The code (e.g. not-entitled, rate-limited) is what tells the operator what to do; it carries no content.
            deps.logger.warn('registration.unavailable', { status: call.status, code: call.problem.code });
            return { kind: 'unavailable' };
        case 'ok': {
            const check = await checkRegistrationResponse(call.response, deps.identity.publicKey, deps.engineDomain);
            if (check.kind !== 'ok') return { kind: 'refused-response', reason: check.kind };
            const registration: Registration = Object.freeze({
                dashboardUrl: deps.dashboardUrl,
                engineId: call.response.engineId,
                hostname: call.response.hostname,
                relays: Object.freeze([...call.response.relays]),
            });
            await deps.store.save(registration);
            return { kind: 'registered', registration };
        }
    }
}
