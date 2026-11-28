import type { EngineId, Hostname, LinkCode, LinkUrlProblem, OwnerSetupCommitment } from '@ptbk/protocol';
import { defaultHostname, parseLinkArgument } from '@ptbk/protocol';

import type { Clock } from '../domain/clock';
import type { DashboardApi } from '../domain/dashboard/dashboard-api';
import type { IdentityStore } from '../domain/identity/engine-identity';
import type { Logger } from '../domain/logger';
import type { LinkAnswer } from '../domain/onboarding/operator-api';
import type { Random } from '../domain/random';
import type { RegistrationOutcome, UnavailableReason } from '../domain/registration/register';
import { registerWithRetry } from '../domain/registration/register-with-retry';
import type { RegistrationStore } from '../domain/registration/registration';
import type { ParsedMockEngineConfig } from './config';
import { ConfigError } from './config';
import type { ExitCode } from './exit-codes';
import type { Say } from './operator-lines';
import { DONE, FAILED, WAITING, identityLines } from './operator-lines';
import { registrationExitCode, registrationSentence, retrySentence } from './registration-messages';
import type { ShowSetupLinkDeps } from './setup-link-command';
import { showFirstSetupLink } from './setup-link-command';

export const CONNECT_USAGE = 'usage: connect --link <link URL or code> [--no-open] [--json]';
export const REGISTER_USAGE = 'usage: register --link <link URL or code>';

/** Messages name the argument, never its value: a mistyped link URL or code is still close to a secret. */
export class ConnectUsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConnectUsageError';
    }
}

export interface ConnectCommand {
    readonly linkCode: LinkCode;
    /** The origin of a link URL; null for a bare code, which needs `PTBK_DASHBOARD_URL` or a stored registration. */
    readonly dashboardOrigin: string | null;
    /** Print one JSON report on stdout instead of the human lines. */
    readonly json: boolean;
    /** Open the setup link in the default browser on a local desktop; `--no-open` says no. */
    readonly open: boolean;
}

const LINK_PROBLEMS: Record<LinkUrlProblem, string> = {
    'not-a-url': '--link must be the link URL the dashboard shows, or its link code',
    'not-https': '--link must be an https:// link URL',
    credentials: '--link must not contain a user name or password',
    'not-link-path': "--link must be the dashboard's /link URL",
    query: '--link must not have a query',
    'invalid-code': '--link has no valid link code after #',
};

function linkOf(value: string): Pick<ConnectCommand, 'linkCode' | 'dashboardOrigin'> {
    const link = parseLinkArgument(value);
    if (link.kind === 'invalid') throw new ConnectUsageError(LINK_PROBLEMS[link.problem]);
    return { linkCode: link.linkCode, dashboardOrigin: link.dashboardOrigin };
}

/** `connect --link <link URL or code> [--no-open] [--json]`, flags in any order. */
export function parseConnectCommand(args: readonly string[]): ConnectCommand {
    let code: string | undefined;
    let json = false;
    let open = true;
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--json' && !json) {
            json = true;
        } else if (arg === '--no-open' && open) {
            open = false;
        } else if (arg === '--link' && code === undefined && args[index + 1] !== undefined) {
            code = args[++index];
        } else {
            throw new ConnectUsageError(CONNECT_USAGE);
        }
    }
    if (code === undefined) throw new ConnectUsageError(CONNECT_USAGE);
    return { ...linkOf(code), json, open };
}

/** `register --link <link URL or code>`: the X-05 name for `connect`, which scripts read as JSON. */
export function parseRegisterCommand(args: readonly string[]): ConnectCommand {
    const [flag, code, ...rest] = args;
    if (flag !== '--link' || code === undefined || rest.length > 0) throw new ConnectUsageError(REGISTER_USAGE);
    return { ...linkOf(code), json: true, open: false };
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
    /** The dashboard's API at the origin this command settled on. */
    readonly api: (dashboardUrl: string) => DashboardApi;
    readonly logger: Logger;
    readonly clock: Clock;
    readonly random: Random;
    /** The operator's terminal; nothing secret is ever said here. */
    readonly say: Say;
    readonly signal: AbortSignal;
    /**
     * Tells an engine already running from this data directory to pick up the registration; null if none answers.
     * `showsSetupLink` tells it that this command shows the first setup link, so the engine does not issue one too.
     */
    readonly joinRunning: (showsSetupLink: boolean) => Promise<LinkAnswer | null>;
    /** Whether stdout is an interactive terminal: only then does `connect` show the setup link. */
    readonly terminal: boolean;
    readonly setupLink: ShowSetupLinkDeps;
    /**
     * Keeps the pairing tab's commitment from a fresh registration as the handoff slot (ADR 0023), where the engine
     * reads it when it links; resolves false with handoff off.
     */
    readonly storeOwnerHandoff: (commitment: OwnerSetupCommitment, registeredAtMs: number) => Promise<boolean>;
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
 * A link URL names its dashboard and overrides nothing silently: if `PTBK_DASHBOARD_URL` names another one, the
 * operator decides. A bare code goes to `PTBK_DASHBOARD_URL`, else to the dashboard the engine registered with.
 */
async function dashboardUrlOf(
    command: ConnectCommand,
    config: ParsedMockEngineConfig,
    registrations: RegistrationStore,
): Promise<string> {
    const configured = config.dashboard?.url ?? null;
    if (command.dashboardOrigin !== null) {
        if (configured !== null && configured !== command.dashboardOrigin) {
            throw new ConfigError([
                `PTBK_DASHBOARD_URL: names ${configured}, but the link URL is for ${command.dashboardOrigin}; unset PTBK_DASHBOARD_URL or use a link from that dashboard`,
            ]);
        }
        return command.dashboardOrigin;
    }
    const url = configured ?? (await registrations.load())?.dashboardUrl ?? null;
    if (url === null) {
        throw new ConfigError(['--link: give the link URL the dashboard shows, or set PTBK_DASHBOARD_URL for a code']);
    }
    return url;
}

/**
 * Creates the engine key if there is none, then registers with the link code, retrying while the platform is
 * unreachable for a while, and hands the registration to an engine already running from this
 * data directory. The key and data are kept whatever the outcome.
 */
export async function runConnectCommand(
    command: ConnectCommand,
    config: ParsedMockEngineConfig,
    deps: ConnectCommandDeps,
): Promise<ConnectResult> {
    const dashboardUrl = await dashboardUrlOf(command, config, deps.registrations);
    const identity = await deps.identityStore.loadOrCreate();
    deps.say(`${DONE} Engine key ready`);
    for (const line of identityLines(identity.engineId, defaultHostname(identity.engineId, config.engineDomain))) {
        deps.say(line);
    }
    // Said before anything is sent, so a link pasted from somewhere shows where it goes. The origin is not a secret.
    deps.say(`${WAITING} Linking with the Promptbook dashboard at ${dashboardUrl}`);
    const outcome = await registerWithRetry({
        store: deps.registrations,
        identity,
        dashboardUrl,
        engineDomain: config.engineDomain,
        api: deps.api(dashboardUrl),
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
    const handedOff =
        outcome.kind === 'registered' &&
        outcome.ownerSetupCommitment !== null &&
        (await deps.storeOwnerHandoff(outcome.ownerSetupCommitment, deps.clock.nowMs()));
    if (exitCode === 0) await join(command, deps, handedOff);
    return { report: reportOf(outcome), exitCode };
}

/**
 * An engine started without a link code waits in local mode; once linked here, it goes online without a restart.
 * Only one setup secret is live at a time, so exactly one process issues the first link: this command when it runs on
 * a terminal (the operator is watching it), else the engine, on its own terminal if it has one.
 */
async function join(command: ConnectCommand, deps: ConnectCommandDeps, handedOff: boolean): Promise<void> {
    const showsSetupLink = deps.terminal && !command.json;
    const answer = await deps.joinRunning(showsSetupLink);
    if (answer === null) {
        deps.say('Start the engine to bring it online; it uses this registration.');
        return;
    }
    switch (answer.outcome) {
        case 'linked':
            deps.say(
                `${DONE} The running engine is linked and connects to ${String(answer.relays)} relay${answer.relays === 1 ? '' : 's'}`,
            );
            // The pairing tab opens the setup page itself; a second one racing it would only confuse.
            if (showsSetupLink) await showFirstSetupLink(command.open && !handedOff, deps.setupLink);
            return;
        case 'already-linked':
            return;
        case 'not-registered':
            deps.say(`${FAILED} The running engine could not read this registration; restart it.`);
            return;
    }
}
