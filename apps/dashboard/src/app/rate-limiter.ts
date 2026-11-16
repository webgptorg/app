import { createBindingRateLimiter, type RateLimitBinding } from '../adapters/rate-limit/binding-rate-limiter';
import {
    createDurableObjectRateLimiter,
    type WindowCounterNamespace,
} from '../adapters/rate-limit/durable-object-rate-limiter';
import { createHmacKeyedRateLimiter } from '../adapters/rate-limit/hmac-keyed-rate-limiter';
import type { Clock } from '../domain/ports/clock';
import {
    RATE_LIMITS,
    type RateLimiter,
    type RateLimitRuleName,
    type RateLimitRules,
} from '../domain/ports/rate-limiter';
import type { DashboardConfig } from './config';

const MINUTE_MS = 60 * 1000;

/** {@link RATE_LIMITS} with the configured limits in place; what every adapter counts with. */
export function rateLimitRules(config: Pick<DashboardConfig, 'heartbeat'>): RateLimitRules {
    return Object.freeze({
        ...RATE_LIMITS,
        'heartbeat-engine': { limit: config.heartbeat.perEngineLimit, windowMs: MINUTE_MS },
    });
}

/**
 * Which production adapter counts each rule. The Workers binding only has 10 s and 60 s periods, so hourly rules go to
 * a Durable Object (decided 2026-10-19 as an interim choice; swapping it touches only this table and its adapter).
 * A binding's limit is fixed in wrangler.jsonc, so rules whose limit is configuration go to the Durable Object too.
 */
export const RULE_ADAPTERS = {
    'signup-start-ip': 'durable-object',
    'signup-start-email': 'durable-object',
    'recovery-request-ip': 'durable-object',
    'recovery-request-email': 'durable-object',
    'registration-ip': 'durable-object',
    'website-access-ip': 'durable-object',
    'options-ip': 'binding',
    'verify-ip': 'binding',
    'public-read-ip': 'binding',
    'webhook-ip': 'binding',
    'registry-relay': 'binding',
    'presence-relay': 'binding',
    'heartbeat-ip': 'binding',
    'heartbeat-engine': 'durable-object',
} as const satisfies Readonly<Record<RateLimitRuleName, 'binding' | 'durable-object'>>;

export function routeByRule(adapters: Readonly<Record<'binding' | 'durable-object', RateLimiter>>): RateLimiter {
    return {
        consume: (rule, key, signal) => adapters[RULE_ADAPTERS[rule]].consume(rule, key, signal),
    };
}

export function createWorkersRateLimiter(deps: {
    readonly clock: Clock;
    readonly hmacKey: Uint8Array;
    readonly options: RateLimitBinding;
    readonly verify: RateLimitBinding;
    readonly publicRead: RateLimitBinding;
    readonly webhook: RateLimitBinding;
    readonly registry: RateLimitBinding;
    readonly presence: RateLimitBinding;
    readonly heartbeat: RateLimitBinding;
    readonly hourly: WindowCounterNamespace;
    readonly rules: RateLimitRules;
}): RateLimiter {
    return createHmacKeyedRateLimiter({
        secret: deps.hmacKey,
        inner: routeByRule({
            binding: createBindingRateLimiter({
                'options-ip': deps.options,
                'verify-ip': deps.verify,
                'public-read-ip': deps.publicRead,
                'webhook-ip': deps.webhook,
                'registry-relay': deps.registry,
                'presence-relay': deps.presence,
                'heartbeat-ip': deps.heartbeat,
            }),
            'durable-object': createDurableObjectRateLimiter({
                namespace: deps.hourly,
                clock: deps.clock,
                rules: deps.rules,
            }),
        }),
    });
}
