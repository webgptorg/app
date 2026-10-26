import type { EngineId, Hostname, LinkCode } from '@ptbk/protocol';
import { LinkCode as LinkCodeSchema, defaultHostname } from '@ptbk/protocol';

import type { Clock } from '../domain/clock';
import type { DashboardApi } from '../domain/dashboard/dashboard-api';
import type { IdentityStore } from '../domain/identity/engine-identity';
import type { Logger } from '../domain/logger';
import type { Random } from '../domain/random';
import type { RegistrationOutcome, UnavailableReason } from '../domain/registration/register';
import { registerWithRetry } from '../domain/registration/register-with-retry';
import type { RegistrationStore } from '../domain/registration/registration';
import type { MockEngineConfig } from './config';
import { ConfigError } from './config';
import type { ExitCode } from './exit-codes';
import type { Say } from './operator-lines';
import { DONE, FAILED, WAITING, identityLines } from './operator-lines';
import { registrationExitCode, registrationSentence, retrySentence } from './registration-messages';

export const CONNECT_USAGE = 'usage: connect --link <code> [--json]';
export const REGISTER_USAGE = 'usage: register --link <code>';

/** Messages name the argument, never its value: a mistyped link code is still close to a secret. */
export class ConnectUsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConnectUsageError';
    }
}

export interface ConnectCommand {
    readonly linkCode: LinkCode;
    /** Print one JSON report on stdout instead of the human lines. */
    readonly json: boolean;
}

function linkCodeOf(code: string): LinkCode {
    const linkCode = LinkCodeSchema.safeParse(code);
    if (!linkCode.success) throw new ConnectUsageError('--link must be a link code');
    return linkCode.data;
}

/** `connect --link <code> [--json]`, flags in any order. */
export function parseConnectCommand(args: readonly string[]): ConnectCommand {
    let code: string | undefined;
    let json = false;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--json' && !json) {
            json = true;
        } else if (arg === '--link' && code === undefined && args[index + 1] !== undefined) {
            code = args[++index];
        } else {
            throw new ConnectUsageError(CONNECT_USAGE);
        }
    }
    if (code === undefined) throw new ConnectUsageError(CONNECT_USAGE);
    return { linkCode: linkCodeOf(code), json };
}

/** `register --link <code>`: the X-05 name for `connect`, which scripts read as JSON. */
export function parseRegisterCommand(args: readonly string[]): ConnectCommand {
    const [flag, code, ...rest] = args;
    if (flag !== '--link' || code === undefined || rest.length > 0) throw new ConnectUsageError(REGISTER_USAGE);
    return { linkCode: linkCodeOf(code), json: true };
}

export type ConnectReport =
    | {
          readonly outcome: 'registered' | 'already-registered';
          readonly engineId: EngineId;
          readonly hostname: Hostname;
          readonly relays: readonly Hostname[];
      }
    | { readonly outcome: 'rejected' | 'refused-response'; readonly reason: string }
    | { readonly outcome: 'unavailable'; readonly reason: UnavailableReason };

export interface ConnectCommandDeps {
    readonly identityStore: IdentityStore;
    readonly registrations: RegistrationStore;
    readonly api: DashboardApi;
    readonly logger: Logger;
    readonly clock: Clock;
    readonly random: Random;
    /** The operator's terminal; nothing secret is ever said here. */
    readonly say: Say;
    readonly signal: AbortSignal;
}

export interface ConnectResult {
    readonly report: ConnectReport;
    readonly exitCode: ExitCode;
}

function reportOf(outcome: RegistrationOutcome): ConnectReport {
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
            return { outcome: outcome.kind, reason: outcome.reason };
    }
}

/**
 * Creates the engine key if there is none, then registers with the link code, retrying while the platform is
 * unreachable and the code can still be valid. The key and data are kept whatever the outcome.
 */
export async function runConnectCommand(
    command: ConnectCommand,
    config: MockEngineConfig,
    deps: ConnectCommandDeps,
): Promise<ConnectResult> {
    if (config.dashboard === null) throw new ConfigError(['PTBK_DASHBOARD_URL: is required to connect']);
    const identity = await deps.identityStore.loadOrCreate();
    deps.say(`${DONE} Engine key ready`);
    for (const line of identityLines(identity.engineId, defaultHostname(identity.engineId, config.engineDomain))) {
        deps.say(line);
    }
    const outcome = await registerWithRetry({
        store: deps.registrations,
        identity,
        dashboardUrl: config.dashboard.url,
        engineDomain: config.engineDomain,
        api: deps.api,
        engineVersion: config.engineVersion,
        linkCode: command.linkCode,
        logger: deps.logger,
        signal: deps.signal,
        clock: deps.clock,
        random: deps.random,
        onRetry: (retry) => {
            deps.say(`${WAITING} ${retrySentence(retry)}`);
        },
    });
    const exitCode = registrationExitCode(outcome);
    deps.say(`${exitCode === 0 ? DONE : FAILED} ${registrationSentence(outcome)}`);
    return { report: reportOf(outcome), exitCode };
}
