import { describe, expect, it } from 'vitest';

import { countAttempt } from './fixed-window';

const RULE = { limit: 2, windowMs: 1000 };

describe('countAttempt', () => {
    it('opens a window on the first attempt, counts up to the limit, then limits until the window ends', () => {
        const first = countAttempt(null, RULE, 100);
        expect(first).toEqual({ kind: 'allowed', state: { start: 100, count: 1 }, newWindow: true });
        const second = countAttempt({ start: 100, count: 1 }, RULE, 500);
        expect(second).toEqual({ kind: 'allowed', state: { start: 100, count: 2 }, newWindow: false });
        expect(countAttempt({ start: 100, count: 2 }, RULE, 1099)).toEqual({ kind: 'limited' });
        expect(countAttempt({ start: 100, count: 2 }, RULE, 1100)).toEqual({
            kind: 'allowed',
            state: { start: 1100, count: 1 },
            newWindow: true,
        });
    });
});
