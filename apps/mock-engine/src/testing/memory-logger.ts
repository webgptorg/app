import type { LogFields, LogLevel, Logger } from '../domain/logger';

export interface LogEntry {
    readonly level: LogLevel;
    readonly event: string;
    readonly fields: LogFields;
}

export interface MemoryLogger extends Logger {
    readonly entries: readonly LogEntry[];
    /** Every entry as one JSON line, for "never logs X" assertions. */
    text(): string;
}

export function createMemoryLogger(): MemoryLogger {
    const entries: LogEntry[] = [];
    return {
        entries,
        text: () => entries.map((entry) => JSON.stringify(entry)).join('\n'),
        info: (event, fields) => entries.push({ level: 'info', event, fields }),
        warn: (event, fields) => entries.push({ level: 'warn', event, fields }),
        error: (event, fields) => entries.push({ level: 'error', event, fields }),
    };
}
