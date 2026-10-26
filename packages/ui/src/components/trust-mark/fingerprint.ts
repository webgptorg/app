/** The seal's grid; `@ptbk/protocol`'s `FINGERPRINT_GRID_SIZE`, repeated because this package imports no contract. */
export const FINGERPRINT_GRID_SIZE = 5;
/** How many `--trust-mark-fp-N` colour tokens the pattern uses. */
export const FINGERPRINT_COLOURS = 6;

/**
 * What the seal draws: the fields of `@ptbk/protocol`'s `EngineFingerprint` it needs, so the apps pass
 * `deriveEngineFingerprint(engineId)` as it is. The design system never derives one; one derivation lives in the
 * open contract, which the engine's terminal and setup page use too.
 */
export interface TrustMarkFingerprint {
    /** `XXXX-XXXX-XXXX-XXXX-XXXX`, as people read and compare it. */
    readonly formatted: string;
    /** The pattern's 15 bits, exposed as `data-fingerprint` for tests. */
    readonly patternBits: string;
    /** `FINGERPRINT_GRID_SIZE` rows of `FINGERPRINT_GRID_SIZE` cells; `true` is filled. */
    readonly cells: readonly (readonly boolean[])[];
}

/** Which `--trust-mark-fp-N` colours a cell: by position only, mirrored like the pattern, never from the digest. */
export function fingerprintColour(row: number, column: number): number {
    const mirrored = Math.min(column, FINGERPRINT_GRID_SIZE - 1 - column);
    return ((row + mirrored) % FINGERPRINT_COLOURS) + 1;
}
