import { DevCaError } from './adapters/dev-ca';
import { createJsonLogger } from './adapters/json-logger';
import { systemClock } from './adapters/system-clock';
import { ConfigError, parseDevCaConfig } from './app/config';
import { DevCaUsageError, parseDevCaCommand, runDevCaCommand } from './app/dev-ca-command';

// Prints the dev CA's (or the issued leaf's) file paths as JSON on stdout; log lines go to stderr.
try {
    const config = parseDevCaConfig(process.env);
    const logger = createJsonLogger({
        level: 'info',
        clock: systemClock,
        write: (line) => process.stderr.write(`${line}\n`),
    });
    const report = await runDevCaCommand(parseDevCaCommand(process.argv.slice(2)), config, {
        clock: systemClock,
        logger,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
    // Our own errors name settings, paths and argument positions, never values; anything else only by its name.
    const known = error instanceof ConfigError || error instanceof DevCaError || error instanceof DevCaUsageError;
    process.stderr.write(`${known ? error.message : error instanceof Error ? error.name : 'unknown error'}\n`);
    process.exitCode = 1;
}
