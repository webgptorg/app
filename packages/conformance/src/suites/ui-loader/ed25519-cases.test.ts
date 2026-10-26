import { ed25519 } from '@noble/curves/ed25519.js';
import { verifyEd25519 } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { ED25519_CASES, ed25519CaseSigner, strictVerdict } from './ed25519-cases';

const STRICT: Record<(typeof ED25519_CASES)[number], boolean> = {
    'prime-order': true,
    's-plus-l': false,
    'small-order-r': true,
    'mixed-order-r': true,
    'mixed-order-a': true,
    'non-canonical-r': false,
    'negative-zero-r': false,
    'small-order-a': false,
    'non-canonical-a': false,
};

// What the vectors' classes are about: each lenient rule accepts what the strict one refuses, or the reverse.
const LENIENT: Partial<Record<(typeof ED25519_CASES)[number], boolean>> = {
    's-plus-l': false,
    'non-canonical-r': true,
    'negative-zero-r': true,
    'small-order-a': true,
    'non-canonical-a': true,
};

describe('ed25519CaseSigner', () => {
    const message = new TextEncoder().encode('DSSEv1 7 example 5 hello');

    it.each(ED25519_CASES)('%s gets the verdict C-01 records for its class', async (kind) => {
        const signer = ed25519CaseSigner(kind);
        expect(await strictVerdict(signer, message)).toBe(STRICT[kind]);
        expect(verifyEd25519(signer.publicKey(), message, await signer.sign(message))).toBe(STRICT[kind]);
    });

    it.each(Object.entries(LENIENT))('%s is accepted by the lenient ZIP-215 rule as expected', async (kind, ok) => {
        const signer = ed25519CaseSigner(kind as (typeof ED25519_CASES)[number]);
        const sig = await signer.sign(message);
        expect(ed25519.verify(sig, message, signer.publicKey(), { zip215: true })).toBe(ok);
    });

    it('puts a torsion component into R or A for the mixed-order cases', async () => {
        const { Point } = ed25519;
        const r = await ed25519CaseSigner('mixed-order-r').sign(message);
        expect(Point.fromBytes(r.slice(0, 32)).isTorsionFree()).toBe(false);
        expect(Point.fromBytes(ed25519CaseSigner('mixed-order-a').publicKey()).isTorsionFree()).toBe(false);
    });
});
