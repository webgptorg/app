import type { Clock } from '../../domain/ports/clock';
import { RATE_LIMITS, type RateLimiter, type RateLimitRules } from '../../domain/ports/rate-limiter';

/** The RPC surface of {@link HourlyRateLimiter}, so this adapter does not depend on `cloudflare:workers`. */
export interface WindowCounterStub {
    consume(limit: number, windowMs: number, nowMs: number): Promise<'allowed' | 'limited'>;
}

export interface WindowCounterNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): WindowCounterStub;
}

/**
 * One Durable Object per rule and key: exact and global, for windows the Workers binding cannot express (an hour).
 * The key must already be an HMAC (see `createHmacKeyedRateLimiter`): it becomes the object's name.
 */
export function createDurableObjectRateLimiter(deps: {
    readonly namespace: WindowCounterNamespace;
    readonly clock: Clock;
    readonly rules?: RateLimitRules;
}): RateLimiter {
    const rules = deps.rules ?? RATE_LIMITS;
    return {
        async consume(rule, key, signal) {
            const { limit, windowMs } = rules[rule];
            try {
                signal.throwIfAborted();
                const stub = deps.namespace.get(deps.namespace.idFromName(key));
                return await stub.consume(limit, windowMs, deps.clock.nowMs());
            } catch {
                return 'unavailable';
            }
        },
    };
}
