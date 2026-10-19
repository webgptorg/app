import type { LogFields, Logger } from '../domain/ports/logger';

/** One JSON line per event, which Workers observability indexes by field. */
export function createConsoleLogger(base: LogFields): Logger {
    const write = (level: 'info' | 'warn' | 'error', event: string, fields: LogFields = {}): void => {
        console[level](JSON.stringify({ ...fields, ...base, level, event }));
    };
    return {
        info: (event, fields) => {
            write('info', event, fields);
        },
        warn: (event, fields) => {
            write('warn', event, fields);
        },
        error: (event, fields) => {
            write('error', event, fields);
        },
    };
}
