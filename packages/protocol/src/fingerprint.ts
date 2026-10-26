import { sha256 } from '@noble/hashes/sha2.js';

import { concatBytes, utf8Encode } from './bytes';

/**
 * The derivation's domain prefix. It carries the version: changing anything below changes every engine's mark, so a
 * new derivation is `ptbk-fingerprint-v2` next to this one, never an edit of it.
 */
export const FINGERPRINT_DERIVATION = 'ptbk-fingerprint-v1';

/** The pattern is `FINGERPRINT_GRID_SIZE` rows of `FINGERPRINT_GRID_SIZE` cells. */
export const FINGERPRINT_GRID_SIZE = 5;

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_BITS = 100;
const PATTERN_BITS = 15;
const GROUP_LENGTH = 4;

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

function digestBits(engineId: string): string {
    const digest = sha256(concatBytes(utf8Encode(FINGERPRINT_DERIVATION), utf8Encode(engineId)));
    return Array.from(digest, (byte) => byte.toString(2).padStart(8, '0')).join('');
}

/**
 * The engine fingerprint people compare between the engine's terminal and setup page, the engine UI and the dashboard,
 * like Signal safety numbers. A recognition aid only: the security property stays the engine ID in the hostname.
 * Synchronous (unlike WebCrypto), so a UI can derive it while rendering. Pinned by `fingerprint-vectors.json`.
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
