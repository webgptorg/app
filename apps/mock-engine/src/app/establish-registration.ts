import type { EngineVersion, Hostname } from '@ptbk/protocol';

import type { Clock } from '../domain/clock';
import type { DashboardApi } from '../domain/dashboard/dashboard-api';
import type { EngineIdentity } from '../domain/identity/engine-identity';
import type { Logger } from '../domain/logger';
import type { Random } from '../domain/random';
import type { RegistrationOutcome } from '../domain/registration/register';
import { loadRegistration } from '../domain/registration/register';
import type { RegistrationRetry } from '../domain/registration/register-with-retry';
import { registerWithRetry } from '../domain/registration/register-with-retry';
import type { Registration, RegistrationStore } from '../domain/registration/registration';
import type { DashboardConfig } from './config';
import type { ExitCode } from './exit-codes';
import { EXIT_CODE } from './exit-codes';
import { registrationExitCode, registrationSentence } from './registration-messages';

/**
 * Startup cannot continue without a registration. The message names the outcome, never the link code; `sentence` is
 * the operator's next step and `exitCode` the class, as for `connect`.
 */
export class RegistrationFailedError extends Error {
    readonly exitCode: ExitCode;
    readonly sentence: string | null;

    constructor(message: string, exitCode: ExitCode = EXIT_CODE.failed, sentence: string | null = null) {
        super(message);
        this.name = 'RegistrationFailedError';
        this.exitCode = exitCode;
        this.sentence = sentence;
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
    readonly clock: Clock;
    readonly random: Random;
    readonly signal: AbortSignal;
    readonly onRetry?: (retry: RegistrationRetry) => void;
}

/** The registration, or why there is none, in words safe to print. */
export function describeOutcome(outcome: RegistrationOutcome): string {
    switch (outcome.kind) {
        case 'registered':
        case 'already-registered':
            return outcome.kind;
        case 'rejected':
        case 'refused-response':
        case 'unavailable':
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
        case 'unavailable':
            logger.error(`registration.${outcome.kind}`, { reason: outcome.reason });
            throw new RegistrationFailedError(
                `registration ${describeOutcome(outcome)}`,
                registrationExitCode(outcome),
                registrationSentence(outcome),
            );
    }
}

/**
 * Startup with `PTBK_DASHBOARD_URL`: register with `PTBK_LINK_CODE` (which an existing registration makes
 * unnecessary), else load the stored registration; `null` when there is neither, and the engine waits for `connect`.
 * The link code is taken from the config here and nowhere else.
 */
export async function establishRegistration(deps: EstablishRegistrationDeps): Promise<Registration | null> {
    const linkCode = deps.dashboard.linkCode?.take() ?? null;
    const stored = { store: deps.store, identity: deps.identity, dashboardUrl: deps.dashboard.url };
    if (linkCode === null) {
        const registration = await loadRegistration({ ...stored, engineDomain: deps.engineDomain });
        return registration === null ? null : registrationOf({ kind: 'already-registered', registration }, deps.logger);
    }
    const outcome = await registerWithRetry({
        ...stored,
        engineDomain: deps.engineDomain,
        api: deps.api,
        engineVersion: deps.engineVersion,
        linkCode,
        logger: deps.logger,
        clock: deps.clock,
        random: deps.random,
        signal: deps.signal,
        ...(deps.onRetry === undefined ? {} : { onRetry: deps.onRetry }),
    });
    return registrationOf(outcome, deps.logger);
}
