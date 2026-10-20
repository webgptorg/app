import { describe, expect, it } from 'vitest';

import { deriveEngineFingerprint, FINGERPRINT_DERIVATION, fingerprintColour } from './fingerprint';
import vectorFile from './fingerprint-vectors.json';

describe('deriveEngineFingerprint', () => {
    it('pins the derivation version the vectors were computed for', () => {
        expect(vectorFile.derivation).toBe(FINGERPRINT_DERIVATION);
        expect(vectorFile.vectors.length).toBeGreaterThanOrEqual(8);
    });

    it.each(vectorFile.vectors)('matches the committed vector for $engineId', (vector) => {
        const fingerprint = deriveEngineFingerprint(vector.engineId);
        expect(fingerprint.code).toBe(vector.code);
        expect(fingerprint.formatted).toBe(vector.formatted);
        expect(fingerprint.patternBits).toBe(vector.patternBits);
    });

    it('is a 20-character Crockford base32 code shown in five groups of four', () => {
        for (const { engineId } of vectorFile.vectors) {
            const { code, formatted } = deriveEngineFingerprint(engineId);
            expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
            expect(formatted).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
            expect(formatted.replaceAll('-', '')).toBe(code);
        }
    });

    it('lays the 15 pattern bits row-major over columns 0-2 and mirrors them to columns 4-3', () => {
        for (const { engineId } of vectorFile.vectors) {
            const { patternBits, cells } = deriveEngineFingerprint(engineId);
            expect(cells).toHaveLength(5);
            cells.forEach((row, rowIndex) => {
                expect(row).toHaveLength(5);
                expect(
                    row
                        .slice(0, 3)
                        .map((filled) => (filled ? '1' : '0'))
                        .join(''),
                ).toBe(patternBits.slice(rowIndex * 3, rowIndex * 3 + 3));
                expect(row[3]).toBe(row[1]);
                expect(row[4]).toBe(row[0]);
            });
        }
    });

    it('is deterministic and tells engines apart', () => {
        const ids = vectorFile.vectors.map((vector) => vector.engineId);
        expect(deriveEngineFingerprint(ids[0] ?? '')).toEqual(deriveEngineFingerprint(ids[0] ?? ''));
        expect(new Set(ids.map((id) => deriveEngineFingerprint(id).code)).size).toBe(ids.length);
        expect(deriveEngineFingerprint('engine-a').code).not.toBe(deriveEngineFingerprint('engine-b').code);
    });

    it('colours cells by position only, symmetric like the pattern', () => {
        expect(fingerprintColour(0, 0)).toBe(1);
        expect(fingerprintColour(0, 4)).toBe(1);
        expect(fingerprintColour(1, 3)).toBe(3);
        expect(fingerprintColour(4, 2)).toBe(1);
        for (let row = 0; row < 5; row += 1) {
            for (let column = 0; column < 5; column += 1) {
                expect(fingerprintColour(row, column)).toBe(fingerprintColour(row, 4 - column));
                expect(fingerprintColour(row, column)).toBeGreaterThanOrEqual(1);
                expect(fingerprintColour(row, column)).toBeLessThanOrEqual(6);
            }
        }
    });
});
