import { sha256 } from '@noble/hashes/sha2.js';

/**
 * The derivation's domain prefix. It carries the version: changing anything below changes every engine's mark, so a
 * new derivation gets a new prefix and the dashboard and engine-ui must move together.
 */
export const FINGERPRINT_DERIVATION = 'ptbk-fingerprint-v1';

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_BITS = 100;
const PATTERN_BITS = 15;
const GROUP_LENGTH = 4;
export const FINGERPRINT_GRID_SIZE = 5;
/** How many `--trust-mark-fp-N` colour tokens the pattern uses. */
export const FINGERPRINT_COLOURS = 6;

export interface EngineFingerprint {
    /** 20 Crockford base32 characters: the digest's first 100 bits. */
    readonly code: string;
    /** `code` in groups of four, `XXXX-XXXX-XXXX-XXXX-XXXX`, as people read and compare it. */
    readonly formatted: string;
    /** The 15 digest bits after the code, `0` or `1`, in derivation order. */
    readonly patternBits: string;
    /** 5 rows of 5 cells, horizontally symmetric; `true` is filled. */
    readonly cells: readonly (readonly boolean[])[];
}

const encoder = new TextEncoder();

function digestBits(engineId: string): string {
    const prefix = encoder.encode(FINGERPRINT_DERIVATION);
    const id = encoder.encode(engineId);
    const input = new Uint8Array(prefix.length + id.length);
    input.set(prefix);
    input.set(id, prefix.length);
    return Array.from(sha256(input), (byte) => byte.toString(2).padStart(8, '0')).join('');
}

/**
 * A recognition aid users compare across devices, like Signal safety numbers; the security property stays the engine
 * ID in the hostname. Synchronous and deterministic, so the same engine ID renders the same mark in engine-ui and the
 * dashboard. The exact derivation is pinned by `fingerprint-vectors.json`.
 */
export function deriveEngineFingerprint(engineId: string): EngineFingerprint {
    const bits = digestBits(engineId);
    let code = '';
    for (let offset = 0; offset < CODE_BITS; offset += 5) {
        code += CROCKFORD_BASE32.charAt(Number.parseInt(bits.slice(offset, offset + 5), 2));
    }
    const groups: string[] = [];
    for (let offset = 0; offset < code.length; offset += GROUP_LENGTH) {
        groups.push(code.slice(offset, offset + GROUP_LENGTH));
    }
    const patternBits = bits.slice(CODE_BITS, CODE_BITS + PATTERN_BITS);
    const half = Math.ceil(FINGERPRINT_GRID_SIZE / 2);
    const cells = Array.from({ length: FINGERPRINT_GRID_SIZE }, (_, row) =>
        Array.from({ length: FINGERPRINT_GRID_SIZE }, (_, column) => {
            const source = Math.min(column, FINGERPRINT_GRID_SIZE - 1 - column);
            return patternBits.charAt(row * half + source) === '1';
        }),
    );
    return { code, formatted: groups.join('-'), patternBits, cells };
}

/** Which `--trust-mark-fp-N` colours a cell: by position only, mirrored like the pattern, never from the digest. */
export function fingerprintColour(row: number, column: number): number {
    const mirrored = Math.min(column, FINGERPRINT_GRID_SIZE - 1 - column);
    return ((row + mirrored) % FINGERPRINT_COLOURS) + 1;
}
