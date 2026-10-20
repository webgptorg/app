import type { RateLimiter } from '../../domain/ports/rate-limiter';
import { toBase64Url } from '../../domain/auth/secrets';

/**
 * Replaces each key with `HMAC-SHA-256(secret, rule ‖ 0x00 ‖ key)`, base64url. Raw IPs and emails never reach the
 * limiter's storage, names or logs; a keyed hash, unlike a plain one, cannot be reversed by trying every IPv4 address.
 */
export function createHmacKeyedRateLimiter(deps: {
    readonly inner: RateLimiter;
    readonly secret: Uint8Array;
}): RateLimiter {
    let key: Promise<CryptoKey> | undefined;
    const encoder = new TextEncoder();
    return {
        async consume(rule, value, signal) {
            key ??= crypto.subtle.importKey(
                'raw',
                Uint8Array.from(deps.secret),
                { name: 'HMAC', hash: 'SHA-256' },
                false,
                ['sign'],
            );
            const mac = await crypto.subtle.sign('HMAC', await key, encoder.encode(`${rule}\0${value}`));
            return deps.inner.consume(rule, toBase64Url(new Uint8Array(mac)), signal);
        },
    };
}
