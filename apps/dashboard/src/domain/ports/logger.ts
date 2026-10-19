/** Primitive values only, so a structured object (a request body, headers) cannot be logged by accident. */
export type LogFields = Readonly<Record<string, string | number | boolean>>;

/** Events are stable identifiers such as `http.unhandled-error`; fields never carry content, tokens or cookies. */
export interface Logger {
    info(event: string, fields?: LogFields): void;
    warn(event: string, fields?: LogFields): void;
    error(event: string, fields?: LogFields): void;
}
