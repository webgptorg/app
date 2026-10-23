import type { LogFields, LogLevel, Logger } from '../domain/logger';
import { isAllowedLogField } from '../domain/log-events';

export interface LogEntry {
    readonly level: LogLevel;
    readonly event: string;
    readonly fields: LogFields;
}

export interface MemoryLogger extends Logger {
    readonly entries: readonly LogEntry[];
}

/**
 * Records every entry, and throws on a field outside its event's allowlist, so every test that logs also checks the
 * allowlist.
 */
export function createMemoryLogger(): MemoryLogger {
    const entries: LogEntry[] = [];
    const record = (level: LogLevel, event: string, fields: Readonly<Partial<LogFields>>): void => {
        const unlisted = Object.keys(fields).filter((name) => !isAllowedLogField(event, name));
        if (unlisted.length > 0) throw new Error(`${event} may not log ${unlisted.join(', ')}`);
        entries.push({ level, event, fields: fields as LogFields });
    };
    return {
        entries,
        info: (event, fields) => {
            record('info', event, fields);
        },
        warn: (event, fields) => {
            record('warn', event, fields);
        },
        error: (event, fields) => {
            record('error', event, fields);
        },
    };
}
