import { createCryptoRandom } from '@ptbk/protocol';

import { DevCaError, createDevCaCertificateSource, loadOrCreateDevCa } from './adapters/dev-ca';
import { TrustedRootsError, loadTrustedRoots } from './adapters/extra-ca';
import { createFetchDashboardApi } from './adapters/fetch-dashboard-api';
import { IdentityStoreError, createFsIdentityStore } from './adapters/fs-identity-store';
import { RegistrationStoreError, createFsRegistrationStore } from './adapters/fs-registration-store';
import { SeqStoreError, createFsSeqStore } from './adapters/fs-seq-store';
import { createHttpsFetch } from './adapters/https-fetch';
import { createJsonLogger } from './adapters/json-logger';
import { createOsSystemStats } from './adapters/os-system-stats';
import { systemClock } from './adapters/system-clock';
import { createWsRelayDialer } from './adapters/ws-relay-dialer';
import type { MockEngineConfig } from './app/config';
import { ConfigError, parseMockEngineConfig } from './app/config';
import { RegistrationFailedError } from './app/establish-registration';
import { RegisterUsageError, isRegistered, parseRegisterCommand, runRegisterCommand } from './app/register-command';
import type { DashboardDeps, MockEngine } from './app/start-mock-engine';
import { startMockEngine } from './app/start-mock-engine';
import type { Logger } from './domain/logger';
import { StoredRegistrationError } from './domain/registration/register';

const SHUTDOWN_TIMEOUT_MS = 10_000;

// Our own startup errors name settings and paths, never values; anything else may carry values, so only its name.
function problemOf(error: unknown): string {
    if (
        error instanceof ConfigError ||
        error instanceof IdentityStoreError ||
        error instanceof TrustedRootsError ||
        error instanceof DevCaError ||
        error instanceof RegistrationFailedError ||
        error instanceof RegistrationStoreError ||
        error instanceof StoredRegistrationError ||
        error instanceof SeqStoreError ||
        error instanceof RegisterUsageError
    ) {
        return error.message;
    }
    return error instanceof Error ? error.name : 'unknown';
}

/** Registration and heartbeat go straight to the dashboard over HTTPS, through the same proxy and roots as the relays. */
function dashboardDeps(config: MockEngineConfig, ca: readonly string[] | undefined): DashboardDeps | undefined {
    if (config.dashboard === null) return undefined;
    return {
        api: createFetchDashboardApi({
            baseUrl: config.dashboard.url,
            fetch: createHttpsFetch({ proxy: config.proxy, ca }),
            clock: systemClock,
        }),
        registrations: createFsRegistrationStore(config.dataDir),
        seqs: createFsSeqStore(config.dataDir, { clock: systemClock }),
        systemStats: createOsSystemStats(config.dataDir),
    };
}

function parseConfig(): MockEngineConfig {
    const config = parseMockEngineConfig(process.env);
    // The config holds the link code now, to be taken once; the environment need not keep a copy.
    delete process.env['PTBK_LINK_CODE'];
    return config;
}

/** `mock-engine register --link <code>`: prints the outcome as JSON, exits 0 only when registered. */
async function register(args: readonly string[]): Promise<void> {
    const logger = createJsonLogger({
        level: 'info',
        clock: systemClock,
        write: (line) => process.stderr.write(`${line}\n`),
    });
    try {
        const command = parseRegisterCommand(args);
        const config = parseConfig();
        const identityStore = createFsIdentityStore(config.dataDir);
        const deps = dashboardDeps(config, await loadTrustedRoots(config.extraCaFile));
        if (deps === undefined) throw new ConfigError(['PTBK_DASHBOARD_URL: is required to register']);
        const report = await runRegisterCommand(command, config, { ...deps, identityStore, logger });
        process.stdout.write(`${JSON.stringify(report)}\n`);
        if (!isRegistered(report)) process.exitCode = 1;
    } catch (error) {
        logger.error('register.failed', { problem: problemOf(error) });
        process.exitCode = 1;
    }
}

async function start(): Promise<{ readonly engine: MockEngine; readonly logger: Logger } | null> {
    let logger = createJsonLogger({ level: 'info', clock: systemClock });
    try {
        const config = parseConfig();
        logger = createJsonLogger({ level: config.logLevel, clock: systemClock });
        const ca = await loadTrustedRoots(config.extraCaFile);
        const devCa = await loadOrCreateDevCa({
            files: config.devCaFiles,
            dataDir: config.dataDir,
            permittedDomains: [config.engineDomain, ...config.devCaDomains],
            clock: systemClock,
            logger,
        });
        const engine = await startMockEngine(config, {
            logger,
            clock: systemClock,
            random: createCryptoRandom(),
            identityStore: createFsIdentityStore(config.dataDir),
            dialer: createWsRelayDialer({ clock: systemClock, proxy: config.proxy, ca }),
            certificates: createDevCaCertificateSource({ ca: devCa, clock: systemClock, logger }),
            dashboard: dashboardDeps(config, ca),
        });
        return { engine, logger };
    } catch (error) {
        logger.error('engine.start-failed', { problem: problemOf(error) });
        return null;
    }
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

const [verb, ...args] = process.argv.slice(2);
if (verb === 'register') {
    await register(args);
} else {
    const started = await start();
    if (started === null) process.exitCode = 1;
    else serve(started.engine, started.logger);
}
