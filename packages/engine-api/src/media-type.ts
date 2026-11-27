/**
 * A `Content-Type` value in the one spelling the contract compares: lowercase, no whitespace, parameter values
 * unquoted, parameters in the order sent. `audio/ogg; codecs="opus"` (Firefox's `MediaRecorder`) becomes
 * `audio/ogg;codecs=opus`. Not a full RFC 9110 parser: values with `;`, `,` or escapes inside quotes are refused.
 */
export function normalizeMediaType(value: string): string | null {
    const parts = value.split(';').map((part) => part.trim());
    const [essence, ...parameters] = parts;
    if (essence === undefined || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(essence)) return null;
    const normalized = [essence.toLowerCase()];
    for (const parameter of parameters) {
        const match = /^([a-z0-9!#$&^_.+-]+)\s*=\s*(?:"([^"\\]*)"|([^\s"\\]+))$/i.exec(parameter);
        if (match === null) return null;
        const [, name = '', quoted, bare] = match;
        normalized.push(`${name.toLowerCase()}=${(quoted ?? bare ?? '').toLowerCase()}`);
    }
    return normalized.join(';');
}

/** The entry of `allowed` that `value` names after normalisation, or `null`; `allowed` is written normalised. */
export function matchMediaType<const Allowed extends string>(
    value: string | null | undefined,
    allowed: readonly Allowed[],
): Allowed | null {
    if (value === null || value === undefined) return null;
    const normalized = normalizeMediaType(value);
    return allowed.find((candidate) => candidate === normalized) ?? null;
}
