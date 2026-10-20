import type { LogFields, LogLevel, Logger } from '../domain/logger';

export interface LogEntry {
    readonly level: LogLevel;
    readonly event: string;
    readonly fields: LogFields;
}

export interface MemoryLogger extends Logger {
    readonly entries: readonly LogEntry[];
}

export function createMemoryLogger(): MemoryLogger {
    const entries: LogEntry[] = [];
    return {
        entries,
        info: (event, fields) => entries.push({ level: 'info', event, fields }),
        warn: (event, fields) => entries.push({ level: 'warn', event, fields }),
        error: (event, fields) => entries.push({ level: 'error', event, fields }),
    };
}
