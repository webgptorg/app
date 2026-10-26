import { describe, expect, it } from 'vitest';

import { FINGERPRINT_COLOURS, FINGERPRINT_GRID_SIZE, fingerprintColour } from './fingerprint';

describe('fingerprintColour', () => {
    it('colours cells by position only, symmetric like the pattern', () => {
        expect(fingerprintColour(0, 0)).toBe(1);
        expect(fingerprintColour(0, 4)).toBe(1);
        expect(fingerprintColour(1, 3)).toBe(3);
        expect(fingerprintColour(4, 2)).toBe(1);
        for (let row = 0; row < FINGERPRINT_GRID_SIZE; row += 1) {
            for (let column = 0; column < FINGERPRINT_GRID_SIZE; column += 1) {
                expect(fingerprintColour(row, column)).toBe(fingerprintColour(row, FINGERPRINT_GRID_SIZE - 1 - column));
                expect(fingerprintColour(row, column)).toBeGreaterThanOrEqual(1);
                expect(fingerprintColour(row, column)).toBeLessThanOrEqual(FINGERPRINT_COLOURS);
            }
        }
    });
});
