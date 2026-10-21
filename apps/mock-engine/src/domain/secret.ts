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

/** A secret that can be read once: after `take`, nothing in the process holds it any more (the link code). */
export interface OneTimeSecret<T> {
    /** The value on the first call, null after. */
    take(): T | null;
}

export function oneTimeSecret<T>(value: T): OneTimeSecret<T> {
    let held: T | null = value;
    const redacted = (): string => '[redacted]';
    return Object.freeze({
        take: () => {
            const taken = held;
            held = null;
            return taken;
        },
        toString: redacted,
        toJSON: redacted,
        [Symbol.for('nodejs.util.inspect.custom')]: redacted,
    });
}
