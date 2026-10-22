import { describe, expect, it } from 'vitest';

import { mapConcurrently } from './map-concurrently';

describe('mapConcurrently', () => {
    it('keeps input order and never runs more than the limit at once', async () => {
        let running = 0;
        let peak = 0;
        const results = await mapConcurrently(
            Array.from({ length: 25 }, (_, index) => index),
            10,
            async (item) => {
                running++;
                peak = Math.max(peak, running);
                // Later items finish first, so order must come from the index, not from completion.
                for (let tick = 0; tick < 25 - item; tick++) {
                    await Promise.resolve();
                }
                running--;
                return item * 2;
            },
        );
        expect(results).toEqual(Array.from({ length: 25 }, (_, index) => index * 2));
        expect(peak).toBe(10);
    });

    it('maps nothing to nothing', async () => {
        expect(await mapConcurrently([], 10, () => Promise.reject(new Error('never called')))).toEqual([]);
    });
});
