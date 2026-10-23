import type { Clock } from '../domain/clock';
import type { LogFields, LogLevel, Logger } from '../domain/logger';
import { isAllowedLogField } from '../domain/log-events';
import { LOG_LEVELS } from '../domain/logger';

export interface JsonLoggerOptions {
    readonly level: LogLevel;
    readonly clock: Clock;
    readonly write?: (line: string) => void;
}

function writeStdout(line: string): void {
    process.stdout.write(`${line}\n`);
}

/**
 * One JSON line per event on stdout; `time`, `level` and `event` come first and no field can overwrite them. A field
 * outside the event's allowlist is dropped, so even a cast past the types cannot put it into the journal.
 */
export function createJsonLogger(options: JsonLoggerOptions): Logger {
    const { clock, write = writeStdout } = options;
    const threshold = LOG_LEVELS.indexOf(options.level);
    const log = (level: LogLevel, event: string, fields: Readonly<Partial<LogFields>>): void => {
        if (LOG_LEVELS.indexOf(level) < threshold) return;
        const head = { time: new Date(clock.nowMs()).toISOString(), level, event };
        const allowed = Object.fromEntries(Object.entries(fields).filter(([name]) => isAllowedLogField(event, name)));
        write(JSON.stringify(Object.assign({}, head, allowed, head)));
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
