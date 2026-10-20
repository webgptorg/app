import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../fake-clock';
import { createDurableObjectRateLimiter, type WindowCounterNamespace } from './durable-object-rate-limiter';

function namespace(answer: () => Promise<'allowed' | 'limited'>) {
    const calls: { name: string; args: number[] }[] = [];
    const ns: WindowCounterNamespace = {
        idFromName: (name) => ({ name }) as unknown as DurableObjectId,
        get: (id) => ({
            consume: (limit, windowMs, nowMs) => {
                calls.push({ name: (id as unknown as { name: string }).name, args: [limit, windowMs, nowMs] });
                return answer();
            },
        }),
    };
    return { ns, calls };
}

describe('Durable Object rate limiter', () => {
    it('names one object per key and passes the rule’s limit, window and the clock', async () => {
        const { ns, calls } = namespace(() => Promise.resolve('limited'));
        const limiter = createDurableObjectRateLimiter({ namespace: ns, clock: createFakeClock(42) });
        expect(await limiter.consume('signup-start-ip', 'hmac-key', new AbortController().signal)).toBe('limited');
        expect(calls).toEqual([{ name: 'hmac-key', args: [10, 3_600_000, 42] }]);
    });

    it('fails closed: an object error or an aborted request is unavailable', async () => {
        const { ns } = namespace(() => Promise.reject(new Error('overloaded')));
        const limiter = createDurableObjectRateLimiter({ namespace: ns, clock: createFakeClock() });
        expect(await limiter.consume('signup-start-ip', 'k', new AbortController().signal)).toBe('unavailable');
        const aborted = new AbortController();
        aborted.abort();
        const ok = createDurableObjectRateLimiter({
            namespace: namespace(() => Promise.resolve('allowed')).ns,
            clock: createFakeClock(),
        });
        expect(await ok.consume('signup-start-ip', 'k', aborted.signal)).toBe('unavailable');
    });
});
