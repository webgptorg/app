const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 §6 alphabet in lowercase, without padding. */
export function encodeBase32Lower(bytes: Uint8Array): string {
    let text = '';
    let buffer = 0;
    let bits = 0;
    for (const byte of bytes) {
        buffer = ((buffer << 8) | byte) & 0xfff;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            text += ALPHABET.charAt((buffer >>> bits) & 0x1f);
        }
    }
    if (bits > 0) text += ALPHABET.charAt((buffer << (5 - bits)) & 0x1f);
    return text;
}
