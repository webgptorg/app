import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/utils.js';
import type { Signer } from '@ptbk/protocol';
import { verifyEd25519 } from '@ptbk/protocol';

import { concat } from './archive';

const { Point } = ed25519;
const L = Point.Fn.ORDER;
const P = Point.Fp.ORDER;

/**
 * The case classes of C-01's `ed25519-vectors.json`, rebuilt over whatever message the engine verifies (the PAE of a
 * release), because the vectors' own messages can never be a release. Each case is a release key: its public key goes
 * into the trust policy and its signature over the PAE is the edge case. The verdict to expect is always the
 * protocol's own `verifyEd25519`, so the suite cannot drift from C-01.
 */
export const ED25519_CASES = [
    /** Control: an ordinary signature by a prime-order key. */
    'prime-order',
    /** S + L: the same signature with a non-reduced S. */
    's-plus-l',
    /** R the identity: passes both the cofactored and the cofactorless equation. */
    'small-order-r',
    /** R with a torsion component: passes the cofactored equation only. */
    'mixed-order-r',
    /** A with a torsion component: passes the cofactored equation only. */
    'mixed-order-a',
    /** R the identity encoded with y = p + 1: a decoder that reduces y accepts it. */
    'non-canonical-r',
    /** R the identity with the x sign bit set (negative zero). */
    'negative-zero-r',
    /** A of order 8, S = 0: the cofactored equation holds for any message. */
    'small-order-a',
    /** A the identity encoded with y = p + 1, S = 0. */
    'non-canonical-a',
] as const;
export type Ed25519Case = (typeof ED25519_CASES)[number];

/** Cases whose public key is itself malformed: an engine may refuse such a key in its policy, before any signature. */
export const MALFORMED_KEY_CASES: ReadonlySet<Ed25519Case> = new Set(['small-order-a', 'non-canonical-a']);

// ed25519-speccheck's order-8 point; it generates the whole torsion subgroup.
const TORSION = Point.fromHex('c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa');

const IDENTITY = Point.ZERO.toBytes();
const IDENTITY_Y_ABOVE_P = numberToBytesLE(P + 1n, 32);
const IDENTITY_NEGATIVE_ZERO = Uint8Array.from(IDENTITY, (byte, index) => (index === 31 ? byte | 0x80 : byte));

function randomScalar(): bigint {
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    const scalar = bytesToNumberLE(bytes) % L;
    return scalar === 0n ? 1n : scalar;
}

async function challenge(r: Uint8Array, a: Uint8Array, message: Uint8Array): Promise<bigint> {
    return bytesToNumberLE(new Uint8Array(await crypto.subtle.digest('SHA-512', concat([r, a, message])))) % L;
}

const mod = (value: bigint): bigint => ((value % L) + L) % L;
const signature = (r: Uint8Array, s: bigint): Uint8Array<ArrayBuffer> => concat([r, numberToBytesLE(s, 32)]);

/** A release key whose signatures are the given case; it signs anything, like a hardware key would. */
export function ed25519CaseSigner(kind: Ed25519Case): Signer {
    const a = randomScalar();
    const torsionFree = Point.BASE.multiply(a);
    const point = kind === 'mixed-order-a' ? torsionFree.add(TORSION) : torsionFree;
    const publicKey =
        kind === 'small-order-a'
            ? TORSION.toBytes()
            : kind === 'non-canonical-a'
              ? IDENTITY_Y_ABOVE_P
              : point.toBytes();
    return {
        publicKey: () => publicKey.slice(),
        async sign(message) {
            if (kind === 'small-order-a' || kind === 'non-canonical-a') return signature(IDENTITY, 0n);
            if (kind === 'small-order-r' || kind === 'non-canonical-r' || kind === 'negative-zero-r') {
                const r =
                    kind === 'small-order-r'
                        ? IDENTITY
                        : kind === 'non-canonical-r'
                          ? IDENTITY_Y_ABOVE_P
                          : IDENTITY_NEGATIVE_ZERO;
                return signature(r, mod((await challenge(r, publicKey, message)) * a));
            }
            const nonce = randomScalar();
            const rPoint = Point.BASE.multiply(nonce);
            const r = (kind === 'mixed-order-r' ? rPoint.add(TORSION) : rPoint).toBytes();
            const s = mod(nonce + (await challenge(r, publicKey, message)) * a);
            return signature(r, kind === 's-plus-l' ? s + L : s);
        },
    };
}

/** What a strict verifier (the protocol's) says about this case's signature over `message`. */
export async function strictVerdict(signer: Signer, message: Uint8Array<ArrayBuffer>): Promise<boolean> {
    return verifyEd25519(signer.publicKey(), message, await signer.sign(message));
}
