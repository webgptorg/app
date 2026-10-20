import type { Bytes } from '../bytes';

/** Decodes a lowercase hex digest that already passed its schema (`Sha256Hex`). */
export function fromHexDigest(hex: string): Bytes {
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    return bytes;
}
