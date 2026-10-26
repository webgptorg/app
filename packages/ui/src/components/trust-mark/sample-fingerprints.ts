import type { TrustMarkFingerprint } from './fingerprint';

function sample(formatted: string, patternBits: string, rows: readonly string[]): TrustMarkFingerprint {
    return {
        formatted,
        patternBits,
        cells: rows.map((row) => Array.from({ length: row.length }, (_, column) => row.charAt(column) === '#')),
    };
}

/**
 * Fixed fingerprints for the gallery and tests, copied from `@ptbk/protocol`'s vectors (engine IDs
 * `k3v6xq2mfz4pd7h5wn2rbtcayu`, `q4ndy7ejw3zkp6ftr2hcm5sxlg` and `local-dev-engine-7`). This package draws
 * fingerprints and never derives them; the derivation is tested where it lives.
 */
export const SAMPLE_FINGERPRINTS = Object.freeze({
    lead: sample('1NDX-0Q1T-X19Y-GMFM-B96D', '110111000000100', ['##.##', '#####', '.....', '.....', '#...#']),
    lab: sample('HCMW-GXKG-JKEZ-KGBK-NHGR', '001001000010100', ['..#..', '..#..', '.....', '.#.#.', '#...#']),
    local: sample('AEK7-1ZX0-EZA5-SQ4Y-NK85', '010110000010111', ['.#.#.', '##.##', '.....', '.#.#.', '#####']),
});
