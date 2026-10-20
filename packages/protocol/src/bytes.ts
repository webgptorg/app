/** Bytes backed by a plain `ArrayBuffer`, the form WebCrypto accepts everywhere. */
export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();

export function utf8Encode(text: string): Bytes {
    return encoder.encode(text);
}

export function concatBytes(...parts: readonly Uint8Array[]): Bytes {
    const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}

/**
 * Not constant-time: for public values only (hashes of public data, keys, engine IDs). Secrets are compared as SHA-256
 * digests with the platform's `timingSafeEqual` in the app that holds them, never here.
 */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
