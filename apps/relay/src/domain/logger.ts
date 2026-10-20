/** Primitive values only, so a structured object (a registry entry, a ClientHello) cannot be logged by accident. */
export type LogFields = Readonly<Record<string, string | number | boolean>>;

export const LOG_LEVELS = ['info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Events are short stable names (`relay.started`, `registry.stale`). Fields carry only the metadata the spec lists
 * (Metadata we still see): never content, keys, tokens, file contents or the hostnames of browser connections.
 */
export interface Logger {
    info(event: string, fields: LogFields): void;
    warn(event: string, fields: LogFields): void;
    error(event: string, fields: LogFields): void;
}
