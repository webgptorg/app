import { describe, expect, it } from 'vitest';

import { REFUSAL_REASONS, createReasonCounters } from './reason-counters';

describe('createReasonCounters', () => {
    it('counts each reason from zero and hands out copies', () => {
        const counters = createReasonCounters(REFUSAL_REASONS);
        const empty = counters.snapshot();
        expect(Object.keys(empty)).toEqual([...REFUSAL_REASONS]);
        expect(Object.values(empty).every((count) => count === 0)).toBe(true);
        counters.count('unknown-host');
        counters.count('unknown-host');
        counters.count('timeout');
        expect(counters.snapshot()).toMatchObject({ 'unknown-host': 2, timeout: 1, 'no-sni': 0 });
        expect(empty['unknown-host']).toBe(0);
    });
});
