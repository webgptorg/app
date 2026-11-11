import { createInterface } from 'node:readline';

import { createCryptoRandom } from '@ptbk/protocol';

import { AcmeSetupError, loadOrCreateAcmeAccountKey } from './adapters/acme-account-key';
import { createBrowserOpener } from './adapters/browser-opener';
import type { AcmeCertificateSource } from './adapters/acme-certificate-source';
import { createAcmeCertificateSource } from './adapters/acme-certificate-source';
import { createAcmeClientIssuer } from './adapters/acme-client-issuer';
import { DevCaError, createDevCaCertificateSource, loadOrCreateDevCa } from './adapters/dev-ca';
import { TrustedRootsError, loadTrustedRoots } from './adapters/extra-ca';
import { createFetchDashboardApi } from './adapters/fetch-dashboard-api';
import { IdentityStoreError, createFsIdentityStore } from './adapters/fs-identity-store';
import { RegistrationStoreError, createFsRegistrationStore } from './adapters/fs-registration-store';
import { SeqStoreError, createFsSeqStore } from './adapters/fs-seq-store';
import { createHttpsFetch } from './adapters/https-fetch';
import { createJsonLogger } from './adapters/json-logger';
import { PasskeyStoreError, createFsPasskeyStore } from './adapters/fs-passkey-store';
import { SetupSecretStoreError, createFsSetupSecretStore } from './adapters/fs-setup-secret-store';
import { SpentTicketStoreError, createFsSpentTicketStore } from './adapters/fs-spent-ticket-store';
import { gatewayPagesDir, loadGatewayPageFiles } from './adapters/http/gateway-page-files';
import type { OperatorClient } from './adapters/operator-client';
import { OperatorAnswerError, createOperatorClient } from './adapters/operator-client';
import { OperatorSocketError, startOperatorSocket } from './adapters/operator-socket';
import { createOsSystemStats } from './adapters/os-system-stats';
import { systemClock } from './adapters/system-clock';
import { BundleStoreError } from './adapters/ui/fs-bundle-store';
import { UpdateStateStoreError } from './adapters/ui/fs-update-state-store';
import { createWsRelayDialer } from './adapters/ws-relay-dialer';
import type { MockEngineConfig } from './app/config';
import type { ParsedMockEngineConfig } from './app/config';
import { ConfigError, parseMockEngineConfig, withStoredDashboard } from './app/config';
import {
    ConformanceSessionUsageError,
    parseConformanceSessionCommand,
    runConformanceSessionCommand,
} from './app/conformance-session-command';
import type { ConnectCommand } from './app/connect-command';
import { ConnectUsageError, parseConnectCommand, parseRegisterCommand, runConnectCommand } from './app/connect-command';
import { RegistrationFailedError } from './app/establish-registration';
import { EXIT_CODE } from './app/exit-codes';
import { FAILED } from './app/operator-lines';
import type { SetupLinkDeps, ShowSetupLinkDeps } from './app/setup-link-command';
import {
    SetupLinkUsageError,
    localClockTime,
    parseOwnerCommand,
    parseSetupLinkCommand,
    runOwnerResetCommand,
    runSetupLinkCommand,
} from './app/setup-link-command';
import { StatusUsageError, parseStatusCommand, runStatusCommand } from './app/status-command';
import type { DashboardDeps, MockEngine } from './app/start-mock-engine';
import { startMockEngine } from './app/start-mock-engine';
import { UiLoaderSetupError, createUiLoaderDeps } from './app/ui-loader-deps';
import type { Logger } from './domain/logger';
import type { BrowserSession } from './domain/onboarding/setup-link-delivery';
import { mayOpenBrowser } from './domain/onboarding/setup-link-delivery';
import type { AcmeChallenges } from './domain/tls/acme-challenges';
import { createAcmeChallenges } from './domain/tls/acme-challenges';
import type { ManagedCertificateSource } from './domain/tls/certificate-source';
import { StoredRegistrationError } from './domain/registration/register';

const SHUTDOWN_TIMEOUT_MS = 10_000;
const ENGINE_USAGE = 'usage: mock-engine [--no-open]';
const BROWSER_SESSION: BrowserSession = { platform: process.platform, env: process.env };

class EngineUsageError extends Error {
    constructor() {
        super(ENGINE_USAGE);
        this.name = 'EngineUsageError';
    }
}

// Our own startup errors name settings and paths, never values; anything else may carry values, so only its name.
function problemOf(error: unknown): string {
    if (
        error instanceof ConfigError ||
        error instanceof IdentityStoreError ||
        error instanceof TrustedRootsError ||
        error instanceof DevCaError ||
        error instanceof AcmeSetupError ||
        error instanceof RegistrationFailedError ||
        error instanceof RegistrationStoreError ||
        error instanceof StoredRegistrationError ||
        error instanceof SeqStoreError ||
        error instanceof ConnectUsageError ||
        error instanceof EngineUsageError ||
        error instanceof StatusUsageError ||
        error instanceof SetupLinkUsageError ||
        error instanceof SetupSecretStoreError ||
        error instanceof PasskeyStoreError ||
        error instanceof SpentTicketStoreError ||
        error instanceof OperatorSocketError ||
        error instanceof OperatorAnswerError ||
        error instanceof UiLoaderSetupError ||
        error instanceof BundleStoreError ||
        error instanceof UpdateStateStoreError
    ) {
        return error.message;
    }
    return error instanceof Error ? error.name : 'unknown';
}

/** Registration and heartbeat go straight to the dashboard over HTTPS, through the same proxy and roots as the relays. */
function dashboardApi(config: ParsedMockEngineConfig, ca: readonly string[] | undefined) {
    return (baseUrl: string) =>
        createFetchDashboardApi({ baseUrl, fetch: createHttpsFetch({ proxy: config.proxy, ca }), clock: systemClock });
}

function dashboardDeps(config: MockEngineConfig, ca: readonly string[] | undefined): DashboardDeps | undefined {
    if (config.dashboard === null) return undefined;
    return {
        api: dashboardApi(config, ca)(config.dashboard.url),
        registrations: createFsRegistrationStore(config.dataDir),
        seqs: createFsSeqStore(config.dataDir, { clock: systemClock }),
        systemStats: createOsSystemStats(config.dataDir),
    };
}

interface Certificates {
    readonly source: ManagedCertificateSource;
    readonly acme: AcmeCertificateSource | null;
}

async function certificates(
    config: MockEngineConfig,
    challenges: AcmeChallenges,
    logger: Logger,
): Promise<Certificates> {
    const source = config.certificateSource;
    if (source.kind === 'acme') {
        const acme = await createAcmeCertificateSource({
            issuer: createAcmeClientIssuer({
                directoryUrl: source.directoryUrl,
                accountKey: await loadOrCreateAcmeAccountKey(config.dataDir),
                email: source.email,
                challenges,
                logger,
            }),
            dataDir: config.dataDir,
            clock: systemClock,
            logger,
        });
        return { source: acme, acme };
    }
    const devCa = await loadOrCreateDevCa({
        files: config.devCaFiles,
        dataDir: config.dataDir,
        permittedDomains: [config.engineDomain, ...config.devCaDomains],
        clock: systemClock,
        logger,
    });
    return { source: createDevCaCertificateSource({ ca: devCa, clock: systemClock, logger }), acme: null };
}

function parseConfig(): ParsedMockEngineConfig {
    const config = parseMockEngineConfig(process.env);
    // The config holds the link code now, to be taken once; the environment need not keep a copy.
    delete process.env['PTBK_LINK_CODE'];
    return config;
}

function stdoutLine(line: string): void {
    process.stdout.write(`${line}\n`);
}

function stderrLine(line: string): void {
    process.stderr.write(`${line}\n`);
}

/**
 * `mock-engine connect --link <code> [--json]` (and `register --link <code>`, the same with `--json`): creates the key
 * if needed and registers, then exits with the outcome's class. The human lines carry no secret; with `--json` they go
 * to stderr and stdout holds only the report.
 */
async function connect(parse: (args: readonly string[]) => ConnectCommand, args: readonly string[]): Promise<void> {
    // The log stream goes to stderr here, so stdout carries only what the operator or a script reads.
    const logger = createJsonLogger({ level: 'warn', clock: systemClock, write: stderrLine });
    let command: ConnectCommand;
    try {
        command = parse(args);
    } catch (error) {
        stderrLine(problemOf(error));
        process.exitCode = EXIT_CODE.usage;
        return;
    }
    try {
        const config = parseConfig();
        const operator = createOperatorClient(config.dataDir);
        const result = await runConnectCommand(command, config, {
            api: dashboardApi(config, await loadTrustedRoots(config.extraCaFile)),
            registrations: createFsRegistrationStore(config.dataDir),
            identityStore: createFsIdentityStore(config.dataDir),
            logger,
            clock: systemClock,
            random: createCryptoRandom(),
            say: command.json ? stderrLine : stdoutLine,
            signal: new AbortController().signal,
            joinRunning: (showsSetupLink) => operator.link(showsSetupLink),
            terminal: process.stdout.isTTY,
            setupLink: showSetupLinkDeps(operator),
        });
        if (command.json) stdoutLine(JSON.stringify(result.report));
        process.exitCode = result.exitCode;
    } catch (error) {
        stderrLine(`${FAILED} ${problemOf(error)}`);
        process.exitCode = EXIT_CODE.failed;
    }
}

/** The engine itself takes one flag: `--no-open` keeps the first setup link out of the browser. */
function parseEngineArgs(args: readonly string[]): { readonly open: boolean } {
    if (args.length === 0) return { open: true };
    if (args.length === 1 && args[0] === '--no-open') return { open: false };
    throw new EngineUsageError();
}

async function start(
    args: readonly string[],
): Promise<{ readonly engine: MockEngine; readonly logger: Logger } | null> {
    let logger = createJsonLogger({ level: 'info', clock: systemClock });
    try {
        const { open } = parseEngineArgs(args);
        const parsed = parseConfig();
        logger = createJsonLogger({ level: parsed.logLevel, clock: systemClock });
        const config = await withStoredDashboard(
            parsed,
            async () => (await createFsRegistrationStore(parsed.dataDir).load())?.dashboardUrl ?? null,
        );
        const ca = await loadTrustedRoots(config.extraCaFile);
        const challenges = createAcmeChallenges();
        const tls = await certificates(config, challenges, logger);
        const engine = await startMockEngine(config, {
            logger,
            // Human progress only on a terminal: a service's stdout is a log stream that gets shipped and read by others.
            say: process.stdout.isTTY ? stdoutLine : null,
            // In the foreground the engine shows the first setup link itself, unless `connect` takes that over.
            firstSetupLink: {
                mayOpen: mayOpenBrowser(BROWSER_SESSION, !open),
                openBrowser: createBrowserOpener(process.platform),
            },
            onboarding: {
                setupSecrets: createFsSetupSecretStore(config.dataDir),
                passkeys: createFsPasskeyStore(config.dataDir),
                spentTickets: createFsSpentTicketStore(config.dataDir),
                pages: await loadGatewayPageFiles(gatewayPagesDir(import.meta.url)),
            },
            operatorChannel: (api) => startOperatorSocket({ dataDir: config.dataDir, api, clock: systemClock, logger }),
            clock: systemClock,
            random: createCryptoRandom(),
            identityStore: createFsIdentityStore(config.dataDir),
            dialer: createWsRelayDialer({ clock: systemClock, proxy: config.proxy, ca }),
            certificates: tls.source,
            challenges,
            // The CA validates through a relay, so issuance starts once one routes the engine.
            onLinkState: (_relay, state) => {
                if (state.kind === 'ready') tls.acme?.routable();
            },
            dashboard: dashboardDeps(config, ca),
            ui:
                config.ui === null
                    ? undefined
                    : await createUiLoaderDeps({
                          config: config.ui,
                          dataDir: config.dataDir,
                          fetch: createHttpsFetch({ proxy: config.proxy, ca }),
                          logger,
                      }),
        });
        return { engine, logger };
    } catch (error) {
        logger.error('engine.start-failed', { problem: problemOf(error) });
        if (error instanceof EngineUsageError) {
            stderrLine(ENGINE_USAGE);
            process.exitCode = EXIT_CODE.usage;
        }
        if (error instanceof RegistrationFailedError) {
            if (error.sentence !== null && process.stdout.isTTY) stdoutLine(`${FAILED} ${error.sentence}`);
            process.exitCode = error.exitCode;
        }
        return null;
    }
}

/**
 * The launch contract: an engine that refuses to start exits non-zero, rather than waiting on whatever it opened before
 * it failed. On macOS stdout to a pipe is asynchronous, so the failure line is flushed first.
 */
function exitAfterOutput(code: number): void {
    process.stdout.write('', () => {
        process.stderr.write('', () => process.exit(code));
    });
}

function serve(engine: MockEngine, logger: Logger): void {
    // Clock timers are unref'd, so while every relay is in backoff nothing else would keep the process running.
    const keepAlive = setInterval(() => undefined, 2 ** 30);
    const shutdown = (signal: NodeJS.Signals): void => {
        process.off('SIGTERM', shutdown);
        process.off('SIGINT', shutdown);
        logger.info('engine.stopping', { signal });
        setTimeout(() => {
            logger.error('engine.shutdown-timeout', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
            process.exit(1);
        }, SHUTDOWN_TIMEOUT_MS).unref();
        engine
            .close()
            .catch((error: unknown) => {
                logger.error('engine.close-failed', { problem: problemOf(error) });
                process.exitCode = 1;
            })
            .finally(() => {
                clearInterval(keepAlive);
            });
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}

/** `mock-engine conformance-session --subject …`: prints a session credential as JSON for the conformance harness. */
async function conformanceSession(args: readonly string[]): Promise<void> {
    try {
        const subject = parseConformanceSessionCommand(args);
        const credential = await runConformanceSessionCommand(
            subject,
            parseConfig(),
            globalThis.fetch.bind(globalThis),
        );
        process.stdout.write(`${JSON.stringify(credential)}\n`);
    } catch (error) {
        const problem = error instanceof ConformanceSessionUsageError ? error.message : problemOf(error);
        process.stderr.write(`conformance-session: ${problem}\n`);
        process.exitCode = 1;
    }
}

/** `mock-engine status [--json]`: what the running engine reports about itself; nothing in it is secret. */
async function status(args: readonly string[]): Promise<void> {
    try {
        const command = parseStatusCommand(args);
        const config = parseConfig();
        const client = createOperatorClient(config.dataDir);
        process.exitCode = await runStatusCommand(command, {
            status: () => client.status(),
            out: stdoutLine,
            err: stderrLine,
        });
    } catch (error) {
        stderrLine(problemOf(error));
        process.exitCode = error instanceof StatusUsageError ? EXIT_CODE.usage : EXIT_CODE.failed;
    }
}

function ask(prompt: string): Promise<string | null> {
    if (!process.stdin.isTTY) return Promise.resolve(null);
    const reader = createInterface({ input: process.stdin, output: process.stderr });
    return new Promise((resolve) => {
        reader.question(prompt, (answer) => {
            reader.close();
            resolve(answer);
        });
    });
}

function showSetupLinkDeps(client: OperatorClient): ShowSetupLinkDeps {
    return {
        client,
        out: stdoutLine,
        err: stderrLine,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        nowMs: () => Date.now(),
        clockTime: localClockTime,
        session: BROWSER_SESSION,
        openBrowser: createBrowserOpener(process.platform),
    };
}

function setupLinkDeps(dataDir: string): SetupLinkDeps {
    const client = createOperatorClient(dataDir);
    return {
        ...showSetupLinkDeps(client),
        client,
        terminal: process.stdout.isTTY,
        ask,
    };
}

/**
 * `mock-engine setup-link [--no-wait] [--json]` and `mock-engine owner --reset [--yes] [--no-wait] [--json]`: the only
 * places the setup link is ever printed, on stdout and only to a terminal unless `--json` asks for it.
 */
async function owner(run: 'setup-link' | 'owner', args: readonly string[]): Promise<void> {
    try {
        const config = parseConfig();
        const deps = setupLinkDeps(config.dataDir);
        process.exitCode =
            run === 'setup-link'
                ? await runSetupLinkCommand(parseSetupLinkCommand(args), deps)
                : await runOwnerResetCommand(parseOwnerCommand(args), deps);
    } catch (error) {
        stderrLine(problemOf(error));
        process.exitCode = error instanceof SetupLinkUsageError ? EXIT_CODE.usage : EXIT_CODE.failed;
    }
}

const [verb, ...args] = process.argv.slice(2);
if (verb === 'status') {
    await status(args);
} else if (verb === 'setup-link' || verb === 'owner') {
    await owner(verb, args);
} else if (verb === 'connect') {
    await connect(parseConnectCommand, args);
} else if (verb === 'register') {
    await connect(parseRegisterCommand, args);
} else if (verb === 'conformance-session') {
    await conformanceSession(args);
} else {
    const started = await start(verb === undefined ? [] : [verb, ...args]);
    if (started === null) exitAfterOutput(typeof process.exitCode === 'number' ? process.exitCode : EXIT_CODE.failed);
    else serve(started.engine, started.logger);
}
