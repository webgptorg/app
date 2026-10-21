import type { EngineVersion, Hostname } from '@ptbk/protocol';

import type { DashboardApi } from '../domain/dashboard/dashboard-api';
import type { EngineIdentity } from '../domain/identity/engine-identity';
import type { Logger } from '../domain/logger';
import type { RegistrationOutcome } from '../domain/registration/register';
import { loadRegistration, registerEngine } from '../domain/registration/register';
import type { Registration, RegistrationStore } from '../domain/registration/registration';
import type { DashboardConfig } from './config';

/** Startup cannot continue without a registration. The message names the outcome, never the link code. */
export class RegistrationFailedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RegistrationFailedError';
    }
}

export interface EstablishRegistrationDeps {
    readonly dashboard: DashboardConfig;
    readonly engineDomain: Hostname;
    readonly engineVersion: EngineVersion;
    readonly identity: EngineIdentity;
    readonly api: DashboardApi;
    readonly store: RegistrationStore;
    readonly logger: Logger;
    readonly signal: AbortSignal;
}

/** The registration, or why there is none, in words safe to print. */
export function describeOutcome(outcome: RegistrationOutcome): string {
    switch (outcome.kind) {
        case 'registered':
        case 'already-registered':
        case 'unavailable':
            return outcome.kind;
        case 'rejected':
        case 'refused-response':
            return `${outcome.kind}: ${outcome.reason}`;
    }
}

function registrationOf(outcome: RegistrationOutcome, logger: Logger): Registration {
    switch (outcome.kind) {
        case 'registered':
        case 'already-registered':
            logger.info(`registration.${outcome.kind}`, {
                engineId: outcome.registration.engineId,
                relays: outcome.registration.relays.length,
            });
            return outcome.registration;
        case 'rejected':
        case 'refused-response':
            logger.error(`registration.${outcome.kind}`, { reason: outcome.reason });
            throw new RegistrationFailedError(`registration ${describeOutcome(outcome)}`);
        case 'unavailable':
            throw new RegistrationFailedError('registration unavailable: the dashboard did not answer');
    }
}

/**
 * Startup with `PTBK_DASHBOARD_URL`: register with `PTBK_LINK_CODE` (which an existing registration makes
 * unnecessary), else load the stored registration. The link code is taken from the config here and nowhere else.
 */
export async function establishRegistration(deps: EstablishRegistrationDeps): Promise<Registration> {
    const linkCode = deps.dashboard.linkCode?.take() ?? null;
    const stored = { store: deps.store, identity: deps.identity, dashboardUrl: deps.dashboard.url };
    if (linkCode === null) {
        const registration = await loadRegistration({ ...stored, engineDomain: deps.engineDomain });
        if (registration === null) {
            throw new RegistrationFailedError('not registered: set PTBK_LINK_CODE or run the register command');
        }
        return registrationOf({ kind: 'already-registered', registration }, deps.logger);
    }
    const outcome = await registerEngine({
        ...stored,
        engineDomain: deps.engineDomain,
        api: deps.api,
        engineVersion: deps.engineVersion,
        linkCode,
        logger: deps.logger,
        signal: deps.signal,
    });
    return registrationOf(outcome, deps.logger);
}
