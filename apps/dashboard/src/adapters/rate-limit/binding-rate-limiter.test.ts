import { describe, expect, it } from 'vitest';

import { createBindingRateLimiter } from './binding-rate-limiter';

const signal = new AbortController().signal;

describe('Workers Rate Limiting binding adapter', () => {
    it('asks the rule’s binding with the key and maps its answer', async () => {
        const keys: string[] = [];
        let success = true;
        const limiter = createBindingRateLimiter({
            'verify-ip': {
                limit: ({ key }) => {
                    keys.push(key);
                    return Promise.resolve({ success });
                },
            },
        });
        expect(await limiter.consume('verify-ip', 'k1', signal)).toBe('allowed');
        success = false;
        expect(await limiter.consume('verify-ip', 'k2', signal)).toBe('limited');
        expect(keys).toEqual(['k1', 'k2']);
    });

    it('answers unavailable for a rule without a binding or a failing binding', async () => {
        const limiter = createBindingRateLimiter({
            'verify-ip': { limit: () => Promise.reject(new Error('binding down')) },
        });
        expect(await limiter.consume('verify-ip', 'k', signal)).toBe('unavailable');
        expect(await limiter.consume('options-ip', 'k', signal)).toBe('unavailable');
    });
});
