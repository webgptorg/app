import type { LogEvent, LogFieldName } from './log-events';

export type LogValue = string | number | boolean;

/** Primitive values only, so a structured object (a registry entry, a ClientHello) cannot be logged by accident. */
export type LogFields = Readonly<Record<string, LogValue>>;

/** The fields `event` may carry, from its allowlist in {@link LOG_EVENTS}. */
export type EventFields<E extends LogEvent> = { readonly [F in LogFieldName<E>]?: LogValue };

export const LOG_LEVELS = ['info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Events are short stable names (`relay.started`, `registry.stale`), each with a fixed field allowlist (`LOG_EVENTS`):
 * only the metadata the spec lists (Metadata we still see), never content, keys, tokens, file contents, a browser's
 * address or the hostnames of browser connections.
 */
export interface Logger {
    info<E extends LogEvent>(event: E, fields: EventFields<E>): void;
    warn<E extends LogEvent>(event: E, fields: EventFields<E>): void;
    error<E extends LogEvent>(event: E, fields: EventFields<E>): void;
}
