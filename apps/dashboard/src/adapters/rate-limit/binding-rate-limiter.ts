import type { RateLimiter, RateLimitRuleName } from '../../domain/ports/rate-limiter';

/** The part of the Workers Rate Limiting binding this adapter uses. */
export interface RateLimitBinding {
    limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * The Workers Rate Limiting binding: one binding per rule, its limit and 10 s or 60 s period configured in
 * wrangler.jsonc. It counts per Cloudflare location, which is enough for the per-minute rules it serves.
 */
export function createBindingRateLimiter(
    bindings: Partial<Readonly<Record<RateLimitRuleName, RateLimitBinding>>>,
): RateLimiter {
    return {
        async consume(rule, key) {
            const binding = bindings[rule];
            if (binding === undefined) {
                return 'unavailable';
            }
            try {
                return (await binding.limit({ key })).success ? 'allowed' : 'limited';
            } catch {
                return 'unavailable';
            }
        },
    };
}
