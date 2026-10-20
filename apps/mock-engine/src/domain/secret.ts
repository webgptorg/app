/** A secret that never shows up in `JSON.stringify`, `String()` or `util.inspect`. */
export interface Secret {
    reveal(): string;
}

export function secret(value: string): Secret {
    const redacted = (): string => '[redacted]';
    return Object.freeze({
        reveal: () => value,
        toString: redacted,
        toJSON: redacted,
        [Symbol.for('nodejs.util.inspect.custom')]: redacted,
    });
}
