/** Primitive values only, so a structured object (a message, a frame, a key) cannot be logged by accident. */
export type LogFields = Readonly<Record<string, string | number | boolean>>;

export const LOG_LEVELS = ['info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Events are short stable names (`tunnel.ready`, `tunnel.dial-failed`). Fields carry relay URLs, states, close codes
 * and attempt numbers: never the private key, signatures, proxy credentials or stream bytes.
 */
export interface Logger {
    info(event: string, fields: LogFields): void;
    warn(event: string, fields: LogFields): void;
    error(event: string, fields: LogFields): void;
}
