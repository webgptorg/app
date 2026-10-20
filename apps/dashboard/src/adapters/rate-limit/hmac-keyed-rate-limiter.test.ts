import { describe, expect, it } from 'vitest';

import { toBase64Url } from '../../domain/auth/secrets';
import type { RateLimitRuleName } from '../../domain/ports/rate-limiter';
import { createHmacKeyedRateLimiter } from './hmac-keyed-rate-limiter';

const signal = new AbortController().signal;

async function expectedMac(secret: Uint8Array, message: string): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        Uint8Array.from(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
    return toBase64Url(mac);
}

function recorder() {
    const seen: [RateLimitRuleName, string][] = [];
    return {
        seen,
        inner: {
            consume: (rule: RateLimitRuleName, key: string) => {
                seen.push([rule, key]);
                return Promise.resolve('allowed' as const);
            },
        },
    };
}

describe('HMAC-keyed rate limiter', () => {
    const secret = new TextEncoder().encode('a-secret-of-at-least-thirty-two-bytes!');

    it('hands the inner limiter HMAC-SHA-256(secret, rule ‖ 0 ‖ key), never the raw key', async () => {
        const { seen, inner } = recorder();
        const limiter = createHmacKeyedRateLimiter({ inner, secret });
        expect(await limiter.consume('signup-start-ip', '198.51.100.7', signal)).toBe('allowed');
        await limiter.consume('signup-start-ip', '198.51.100.7', signal);
        await limiter.consume('verify-ip', '198.51.100.7', signal);
        await limiter.consume('signup-start-email', 'person@example.test', signal);
        expect(seen[0]).toEqual(['signup-start-ip', await expectedMac(secret, 'signup-start-ip\u0000198.51.100.7')]);
        expect(seen[1]).toEqual(seen[0]);
        expect(seen[2]?.[1]).not.toBe(seen[0]?.[1]);
        for (const [, key] of seen) {
            expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(key).not.toMatch(/198|example/);
        }
    });

    it('derives different keys under a different secret', async () => {
        const a = recorder();
        const b = recorder();
        await createHmacKeyedRateLimiter({ inner: a.inner, secret }).consume('verify-ip', '192.0.2.1', signal);
        await createHmacKeyedRateLimiter({ inner: b.inner, secret: new Uint8Array(32) }).consume(
            'verify-ip',
            '192.0.2.1',
            signal,
        );
        expect(a.seen[0]?.[1]).not.toBe(b.seen[0]?.[1]);
    });
});
