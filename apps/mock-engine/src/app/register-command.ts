import type { EngineId, Hostname, LinkCode } from '@ptbk/protocol';
import { LinkCode as LinkCodeSchema } from '@ptbk/protocol';

import type { DashboardApi } from '../domain/dashboard/dashboard-api';
import type { IdentityStore } from '../domain/identity/engine-identity';
import type { Logger } from '../domain/logger';
import type { RegistrationOutcome } from '../domain/registration/register';
import { registerEngine } from '../domain/registration/register';
import type { RegistrationStore } from '../domain/registration/registration';
import type { MockEngineConfig } from './config';
import { ConfigError } from './config';

export const REGISTER_USAGE = 'usage: register --link <code>';

/** Messages name the argument, never its value: a mistyped link code is still close to a secret. */
export class RegisterUsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RegisterUsageError';
    }
}

export function parseRegisterCommand(args: readonly string[]): { readonly linkCode: LinkCode } {
    const [flag, code, ...rest] = args;
    if (flag !== '--link' || code === undefined || rest.length > 0) throw new RegisterUsageError(REGISTER_USAGE);
    const linkCode = LinkCodeSchema.safeParse(code);
    if (!linkCode.success) throw new RegisterUsageError('--link must be a link code');
    return { linkCode: linkCode.data };
}

export type RegisterReport =
    | {
          readonly outcome: 'registered' | 'already-registered';
          readonly engineId: EngineId;
          readonly hostname: Hostname;
          readonly relays: readonly Hostname[];
      }
    | { readonly outcome: 'rejected' | 'refused-response'; readonly reason: string }
    | { readonly outcome: 'unavailable' };

export interface RegisterCommandDeps {
    readonly identityStore: IdentityStore;
    readonly registrations: RegistrationStore;
    readonly api: DashboardApi;
    readonly logger: Logger;
}

function reportOf(outcome: RegistrationOutcome): RegisterReport {
    switch (outcome.kind) {
        case 'registered':
        case 'already-registered': {
            const { engineId, hostname, relays } = outcome.registration;
            return { outcome: outcome.kind, engineId, hostname, relays };
        }
        case 'rejected':
        case 'refused-response':
            return { outcome: outcome.kind, reason: outcome.reason };
        case 'unavailable':
            return { outcome: outcome.kind };
    }
}

/** `mock-engine register --link <code>`: registers (or finds the registration) and exits, for X-05. */
export async function runRegisterCommand(
    command: { readonly linkCode: LinkCode },
    config: MockEngineConfig,
    deps: RegisterCommandDeps,
): Promise<RegisterReport> {
    if (config.dashboard === null) throw new ConfigError(['PTBK_DASHBOARD_URL: is required to register']);
    const outcome = await registerEngine({
        store: deps.registrations,
        identity: await deps.identityStore.loadOrCreate(),
        dashboardUrl: config.dashboard.url,
        engineDomain: config.engineDomain,
        api: deps.api,
        engineVersion: config.engineVersion,
        linkCode: command.linkCode,
        logger: deps.logger,
        signal: new AbortController().signal,
    });
    return reportOf(outcome);
}

export function isRegistered(report: RegisterReport): boolean {
    return report.outcome === 'registered' || report.outcome === 'already-registered';
}
