/**
 * Bounds-checked big-endian reads over a byte range. Every read returns `undefined` instead of
 * running past `end`, so parsers of untrusted input cannot read out of bounds or throw.
 */
export interface ByteReader {
    readonly remaining: number;
    u8(): number | undefined;
    u16(): number | undefined;
    bytes(length: number): Uint8Array | undefined;
}

export function createByteReader(source: Uint8Array): ByteReader {
    const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    let offset = 0;

    function take(length: number): number | undefined {
        if (length > source.byteLength - offset) return undefined;
        const start = offset;
        offset += length;
        return start;
    }

    return {
        get remaining() {
            return source.byteLength - offset;
        },
        u8() {
            const at = take(1);
            return at === undefined ? undefined : view.getUint8(at);
        },
        u16() {
            const at = take(2);
            return at === undefined ? undefined : view.getUint16(at);
        },
        bytes(length) {
            const at = take(length);
            return at === undefined ? undefined : source.subarray(at, at + length);
        },
    };
}
