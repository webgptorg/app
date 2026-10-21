import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../adapters/fake-clock';
import { RATE_LIMITS, type RateLimitRuleName } from '../domain/ports/rate-limiter';
import { createWorkersRateLimiter, routeByRule, RULE_ADAPTERS } from './rate-limiter';

const signal = new AbortController().signal;

describe('production rate limiter selection', () => {
    it('sends per-minute rules to the binding and hourly rules to the Durable Object', async () => {
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
            expect(adapter === 'binding', rule).toBe(RATE_LIMITS[rule].windowMs <= 60_000);
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
            hourly: {
                idFromName: () => ({}) as DurableObjectId,
                get: () => ({ consume: () => (calls.push('hourly'), Promise.resolve('allowed')) }),
            },
        });
        const rules = [
            'options-ip',
            'verify-ip',
            'public-read-ip',
            'webhook-ip',
            'registry-relay',
            'recovery-request-email',
        ] as const;
        for (const rule of rules) {
            expect(await limiter.consume(rule, '192.0.2.1', signal)).toBe('allowed');
        }
        expect(calls).toEqual(['options', 'verify', 'public-read', 'webhook', 'registry', 'hourly']);
    });
});
