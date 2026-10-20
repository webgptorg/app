import { createCryptoRandom } from '@ptbk/protocol';

import { TrustedRootsError, loadTrustedRoots } from './adapters/extra-ca';
import { IdentityStoreError, createFsIdentityStore } from './adapters/fs-identity-store';
import { createJsonLogger } from './adapters/json-logger';
import { systemClock } from './adapters/system-clock';
import { createWsRelayDialer } from './adapters/ws-relay-dialer';
import { ConfigError, parseMockEngineConfig } from './app/config';
import type { MockEngine } from './app/start-mock-engine';
import { startMockEngine } from './app/start-mock-engine';
import type { Logger } from './domain/logger';

const SHUTDOWN_TIMEOUT_MS = 10_000;

// Our own startup errors name settings and paths, never values; anything else may carry values, so only its name.
function problemOf(error: unknown): string {
    if (error instanceof ConfigError || error instanceof IdentityStoreError || error instanceof TrustedRootsError) {
        return error.message;
    }
    return error instanceof Error ? error.name : 'unknown';
}

async function start(): Promise<{ readonly engine: MockEngine; readonly logger: Logger } | null> {
    let logger = createJsonLogger({ level: 'info', clock: systemClock });
    try {
        const config = parseMockEngineConfig(process.env);
        logger = createJsonLogger({ level: config.logLevel, clock: systemClock });
        const engine = await startMockEngine(config, {
            logger,
            clock: systemClock,
            random: createCryptoRandom(),
            identityStore: createFsIdentityStore(config.dataDir),
            dialer: createWsRelayDialer({
                clock: systemClock,
                proxy: config.proxy,
                ca: await loadTrustedRoots(config.extraCaFile),
            }),
        });
        return { engine, logger };
    } catch (error) {
        logger.error('engine.start-failed', { problem: problemOf(error) });
        return null;
    }
}

const started = await start();
if (started === null) {
    process.exitCode = 1;
} else {
    const { engine, logger } = started;
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
