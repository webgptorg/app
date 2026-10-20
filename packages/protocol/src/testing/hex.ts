import type { Bytes } from '../bytes';

export function fromHex(hex: string): Bytes {
    if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new TypeError(`not lowercase hex: ${hex}`);
    return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

export function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
