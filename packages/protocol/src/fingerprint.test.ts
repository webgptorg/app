import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { deriveEngineFingerprint, FINGERPRINT_DERIVATION, FINGERPRINT_GRID_SIZE } from './fingerprint';
import vectorFile from './fingerprint-vectors.json';

const CODE = /^[0-9A-HJKMNP-TV-Z]{20}$/;
const FORMATTED = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/;
const LOOKALIKE_ID = 'k3v6xq2mfz4pd7h5wn2rbtcаyu';

function hex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function expectMirroredGrid(patternBits: string, cells: readonly (readonly boolean[])[]): void {
    expect(cells).toHaveLength(FINGERPRINT_GRID_SIZE);
    cells.forEach((row, rowIndex) => {
        expect(row).toHaveLength(FINGERPRINT_GRID_SIZE);
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

describe('deriveEngineFingerprint', () => {
    it('pins the derivation version the vectors were computed for', () => {
        expect(FINGERPRINT_DERIVATION).toBe('ptbk-fingerprint-v1');
        expect(vectorFile.derivation).toBe(FINGERPRINT_DERIVATION);
        expect(vectorFile.vectors.length).toBeGreaterThanOrEqual(8);
    });

    it.each(vectorFile.vectors)('matches the committed vector for $engineId', (vector) => {
        const fingerprint = deriveEngineFingerprint(vector.engineId);
        expect(fingerprint.code).toBe(vector.code);
        expect(fingerprint.formatted).toBe(vector.formatted);
        expect(fingerprint.patternBits).toBe(vector.patternBits);
        expectMirroredGrid(vector.patternBits, fingerprint.cells);
    });

    // The vectors' digests came from Python's hashlib; WebCrypto here checks the input layout independently of noble.
    it.each(vectorFile.vectors)('hashes the prefix immediately followed by $engineId', async (vector) => {
        const input = new TextEncoder().encode(`${FINGERPRINT_DERIVATION}${vector.engineId}`);
        expect(hex(new Uint8Array(await crypto.subtle.digest('SHA-256', input)))).toBe(vector.digestHex);
    });

    it('gives a grouped 20-character Crockford base32 code and a mirrored 5×5 pattern for any input', () => {
        fc.assert(
            fc.property(fc.string({ unit: 'binary', maxLength: 64 }), (engineId) => {
                const { code, formatted, patternBits, cells } = deriveEngineFingerprint(engineId);
                expect(code).toMatch(CODE);
                expect(formatted).toMatch(FORMATTED);
                expect(formatted.replaceAll('-', '')).toBe(code);
                expect(patternBits).toMatch(/^[01]{15}$/);
                expectMirroredGrid(patternBits, cells);
            }),
        );
    });

    it('is deterministic and tells engines apart', () => {
        const ids = vectorFile.vectors.map((vector) => vector.engineId);
        expect(deriveEngineFingerprint(ids[0] ?? '')).toEqual(deriveEngineFingerprint(ids[0] ?? ''));
        expect(new Set(ids.map((id) => deriveEngineFingerprint(id).code)).size).toBe(ids.length);
    });

    it('does not normalise the engine ID: case, look-alikes and whitespace give another code', () => {
        const { code } = deriveEngineFingerprint('k3v6xq2mfz4pd7h5wn2rbtcayu');
        for (const variant of ['K3V6XQ2MFZ4PD7H5WN2RBTCAYU', LOOKALIKE_ID, ' k3v6xq2mfz4pd7h5wn2rbtcayu', '']) {
            expect(deriveEngineFingerprint(variant).code).not.toBe(code);
        }
    });
});
