import { writeSync } from 'node:fs';

import { createJsonLogger } from './adapters/json-logger';
import { createNodeRandom } from './adapters/node-random';
import { StaticRegistryError } from './adapters/static-file-registry';
import { systemClock } from './adapters/system-clock';
import { ConfigError, parseRelayConfig } from './app/config';
import type { Relay } from './app/start-relay';
import { RelayTlsError, startRelay } from './app/start-relay';
import type { Logger } from './domain/logger';

const SHUTDOWN_TIMEOUT_MS = 10_000;

// Our own startup errors name settings and paths, never values; anything else may carry values, so only its name.
function problemOf(error: unknown): string {
    if (error instanceof ConfigError || error instanceof StaticRegistryError || error instanceof RelayTlsError) {
        return error.message;
    }
    return error instanceof Error ? error.name : 'unknown';
}

interface Started {
    readonly relay: Relay;
    readonly logger: Logger;
}

async function start(): Promise<Started | null> {
    let logger = createJsonLogger({ level: 'info', clock: systemClock });
    try {
        const config = parseRelayConfig(process.env);
        logger = createJsonLogger({ level: config.logLevel, clock: systemClock });
        return {
            relay: await startRelay(config, {
                logger,
                clock: systemClock,
                livenessClock: systemClock,
                random: createNodeRandom(),
            }),
            logger,
        };
    } catch (error) {
        logger.error('relay.start-failed', { problem: problemOf(error) });
        return null;
    }
}

// After an error nothing caught, the relay's state is unknown: log the error's name only (its message may quote input)
// and exit for systemd to restart a clean process (I-01). Written synchronously, so the line survives the exit.
const crashLogger = createJsonLogger({
    level: 'error',
    clock: systemClock,
    write: (line) => {
        writeSync(1, `${line}\n`);
    },
});
const crash = (event: string) => (error: unknown) => {
    crashLogger.error(event, { problem: problemOf(error) });
    process.exit(1);
};
process.on('uncaughtException', crash('relay.crashed'));
process.on('unhandledRejection', crash('relay.crashed'));

// Written by the signal handler while `start` runs, so it lives in an object TypeScript does not narrow.
const lifecycle: { started: Started | null; stopSignal: NodeJS.Signals | null } = { started: null, stopSignal: null };

function stop(started: Started, signal: NodeJS.Signals): void {
    const { relay, logger } = started;
    logger.info('relay.stopping', { signal });
    setTimeout(() => {
        logger.error('relay.shutdown-timeout', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
        process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    relay.close().catch((error: unknown) => {
        logger.error('relay.close-failed', { problem: problemOf(error) });
        process.exitCode = 1;
    });
}

// Installed before starting, so a signal that arrives while the relay starts is never handled by Node's default
// (an exit without a graceful close).
const onSignal = (signal: NodeJS.Signals): void => {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    if (lifecycle.started === null) lifecycle.stopSignal = signal;
    else stop(lifecycle.started, signal);
};
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);

lifecycle.started = await start();
if (lifecycle.started === null) {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    process.exitCode = 1;
} else if (lifecycle.stopSignal !== null) {
    stop(lifecycle.started, lifecycle.stopSignal);
}
