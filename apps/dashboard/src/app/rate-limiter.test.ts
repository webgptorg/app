import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../adapters/fake-clock';
import { RATE_LIMITS, type RateLimitRuleName } from '../domain/ports/rate-limiter';
import { createWorkersRateLimiter, rateLimitRules, routeByRule, RULE_ADAPTERS } from './rate-limiter';

/** Rules whose limit is configuration: a binding's limit is fixed in wrangler.jsonc, so they cannot use one. */
const CONFIGURED_RULES: readonly RateLimitRuleName[] = ['heartbeat-engine'];

const signal = new AbortController().signal;

describe('production rate limiter selection', () => {
    it('sends fixed per-minute rules to the binding, hourly and configured ones to the Durable Object', async () => {
        const used: [string, RateLimitRuleName][] = [];
        const limiter = routeByRule({
            binding: { consume: (rule) => (used.push(['binding', rule]), Promise.resolve('allowed')) },
            'durable-object': { consume: (rule) => (used.push(['durable-object', rule]), Promise.resolve('limited')) },
        });
        for (const rule of Object.keys(RATE_LIMITS) as RateLimitRuleName[]) {
            await limiter.consume(rule, 'k', signal);
        }
        for (const [adapter, rule] of used) {
            // The binding only has 10 s and 60 s periods.
            expect(adapter === 'binding', rule).toBe(
                RATE_LIMITS[rule].windowMs <= 60_000 && !CONFIGURED_RULES.includes(rule),
            );
            expect(RULE_ADAPTERS[rule]).toBe(adapter);
        }
        expect(used).toHaveLength(Object.keys(RATE_LIMITS).length);
    });

    it('wires one binding per per-minute rule behind the HMAC keying', async () => {
        const calls: string[] = [];
        const binding = (name: string) => ({ limit: () => (calls.push(name), Promise.resolve({ success: true })) });
        const limiter = createWorkersRateLimiter({
            clock: createFakeClock(),
            hmacKey: new Uint8Array(32),
            options: binding('options'),
            verify: binding('verify'),
            publicRead: binding('public-read'),
            webhook: binding('webhook'),
            registry: binding('registry'),
            presence: binding('presence'),
            heartbeat: binding('heartbeat'),
            hourly: {
                idFromName: () => ({}) as DurableObjectId,
                get: () => ({
                    consume: (limit) => (calls.push(`hourly:${String(limit)}`), Promise.resolve('allowed')),
                }),
            },
            rules: rateLimitRules({ heartbeat: { intervalS: 15, missedLimit: 3, graceS: 15, perEngineLimit: 7 } }),
        });
        const rules = [
            'options-ip',
            'verify-ip',
            'public-read-ip',
            'webhook-ip',
            'registry-relay',
            'heartbeat-ip',
            'recovery-request-email',
            'heartbeat-engine',
        ] as const;
        for (const rule of rules) {
            expect(await limiter.consume(rule, '192.0.2.1', signal)).toBe('allowed');
        }
        expect(calls).toEqual([
            'options',
            'verify',
            'public-read',
            'webhook',
            'registry',
            'heartbeat',
            'hourly:3',
            'hourly:7',
        ]);
    });
});
