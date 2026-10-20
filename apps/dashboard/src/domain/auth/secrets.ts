import type { Random } from '../ports/random';

export function toBase64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 256 random bits (ADR 0014: session and email tokens), base64url without padding: 43 characters. */
export function newSecret(random: Random): string {
    return toBase64Url(random.bytes(32));
}

export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Secrets are stored and looked up only by this digest, so a database leak yields no usable token. */
export async function sha256Hex(value: string): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The inverse of {@link toBase64Url}; the caller has validated the alphabet. */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
