import type { Clock } from '../domain/clock';
import type { LogFields, LogLevel, Logger } from '../domain/logger';
import { LOG_LEVELS } from '../domain/logger';

export interface JsonLoggerOptions {
    readonly level: LogLevel;
    readonly clock: Clock;
    readonly write?: (line: string) => void;
}

function writeStdout(line: string): void {
    process.stdout.write(`${line}\n`);
}

/** One JSON line per event on stdout; `time`, `level` and `event` come first and no field can overwrite them. */
export function createJsonLogger(options: JsonLoggerOptions): Logger {
    const { clock, write = writeStdout } = options;
    const threshold = LOG_LEVELS.indexOf(options.level);
    const log = (level: LogLevel, event: string, fields: LogFields): void => {
        if (LOG_LEVELS.indexOf(level) < threshold) return;
        const head = { time: new Date(clock.nowMs()).toISOString(), level, event };
        write(JSON.stringify(Object.assign({}, head, fields, head)));
    };
    return {
        info: (event, fields) => {
            log('info', event, fields);
        },
        warn: (event, fields) => {
            log('warn', event, fields);
        },
        error: (event, fields) => {
            log('error', event, fields);
        },
    };
}
