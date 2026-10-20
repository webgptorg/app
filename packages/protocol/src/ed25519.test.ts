import { describe, expect, it } from 'vitest';
import type { Bytes } from './bytes';
import { createWebCryptoSigner, generateEd25519KeyPair, importEd25519PrivateKey, verifyEd25519 } from './ed25519';
import vectors from './ed25519-vectors.json';
import { fromHex, toHex } from './testing/hex';

// RFC 8032 §7.1, TEST 1 to TEST 3.
const RFC_8032 = [
    {
        name: 'TEST 1',
        seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
        publicKey: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
        message: '',
        signature:
            'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    },
    {
        name: 'TEST 2',
        seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
        publicKey: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
        message: '72',
        signature:
            '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
    },
    {
        name: 'TEST 3',
        seed: 'c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7',
        publicKey: 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
        message: 'af82',
        signature:
            '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
    },
] as const;

function withBitFlipped(bytes: Bytes, bit: number): Bytes {
    const copy = bytes.slice();
    copy[bit >> 3] = (copy[bit >> 3] ?? 0) ^ (1 << (bit & 7));
    return copy;
}

const bits = (bytes: Uint8Array): number[] => Array.from({ length: bytes.length * 8 }, (_, bit) => bit);

describe.each(RFC_8032)('RFC 8032 $name', (vector) => {
    const seed = fromHex(vector.seed);
    const publicKey = fromHex(vector.publicKey);
    const message = fromHex(vector.message);
    const signature = fromHex(vector.signature);

    it('imports the seed with the vector public key', async () => {
        const keyPair = await importEd25519PrivateKey(seed, { extractable: false });
        expect(toHex(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)))).toBe(vector.publicKey);
        expect(keyPair.privateKey.extractable).toBe(false);
        expect(toHex((await createWebCryptoSigner(keyPair)).publicKey())).toBe(vector.publicKey);
    });

    // Byte-exact: Node signs deterministically. Browsers (Safari) may hedge, so only verification is portable.
    it('signs byte-exactly on Node', async () => {
        const signer = await createWebCryptoSigner(await importEd25519PrivateKey(seed, { extractable: false }));
        expect(toHex(await signer.sign(message))).toBe(vector.signature);
    });

    it('verifies', () => {
        expect(verifyEd25519(publicKey, message, signature)).toBe(true);
    });

    it('fails for every flipped bit in the signature', () => {
        for (const bit of bits(signature)) {
            expect(verifyEd25519(publicKey, message, withBitFlipped(signature, bit)), `bit ${String(bit)}`).toBe(false);
        }
    });

    it('fails for every flipped bit in the public key', () => {
        for (const bit of bits(publicKey)) {
            expect(verifyEd25519(withBitFlipped(publicKey, bit), message, signature), `bit ${String(bit)}`).toBe(false);
        }
    });

    it('fails for every flipped bit in the message, and for a truncated or extended message', () => {
        for (const bit of bits(message)) {
            expect(verifyEd25519(publicKey, withBitFlipped(message, bit), signature), `bit ${String(bit)}`).toBe(false);
        }
        expect(verifyEd25519(publicKey, Uint8Array.from([...message, 0]), signature)).toBe(false);
        if (message.length > 0) expect(verifyEd25519(publicKey, message.slice(0, -1), signature)).toBe(false);
    });

    it('fails for another vector key', () => {
        const other = RFC_8032.find(({ name }) => name !== vector.name);
        expect(verifyEd25519(fromHex(other?.publicKey ?? ''), message, signature)).toBe(false);
    });

    it('returns false, without throwing, for truncated or extended keys and signatures', () => {
        expect(verifyEd25519(publicKey, message, signature.slice(0, 63))).toBe(false);
        expect(verifyEd25519(publicKey, message, Uint8Array.from([...signature, 0]))).toBe(false);
        expect(verifyEd25519(publicKey, message, new Uint8Array(0))).toBe(false);
        expect(verifyEd25519(publicKey.slice(0, 31), message, signature)).toBe(false);
        expect(verifyEd25519(Uint8Array.from([...publicKey, 0]), message, signature)).toBe(false);
        expect(verifyEd25519(new Uint8Array(0), message, signature)).toBe(false);
    });
});

describe('strict verification reference (src/ed25519-vectors.json)', () => {
    it.each(vectors.vectors)('$id: valid = $valid', ({ publicKey, message, signature, valid }) => {
        expect(verifyEd25519(fromHex(publicKey), fromHex(message), fromHex(signature))).toBe(valid);
    });

    it('covers the cases ADR 0014 names', () => {
        const ids = vectors.vectors.map(({ id }) => id);
        expect(ids).toEqual(
            expect.arrayContaining([
                ...Array.from({ length: 12 }, (_, index) => `speccheck-${String(index)}`),
                'small-order-r-identity',
                'non-canonical-r-negative-zero',
                'small-order-a-identity',
                'non-canonical-a-negative-zero-identity',
                'non-canonical-r-y-above-p',
                'non-canonical-a-y-above-p',
                's-equals-l-plus-s',
                's-equals-l',
                's-just-below-l',
            ]),
        );
    });
});

describe('verifyEd25519', () => {
    it('returns false instead of throwing on input noble refuses', () => {
        const [vector] = RFC_8032;
        const notBytes = 'message' as unknown as Bytes;
        expect(verifyEd25519(fromHex(vector.publicKey), notBytes, fromHex(vector.signature))).toBe(false);
    });
});

describe('WebCrypto keys and signer', () => {
    it('generates non-extractable runtime keys whose signatures verify with noble', async () => {
        const keyPair = await generateEd25519KeyPair({ extractable: false });
        expect(keyPair.privateKey.extractable).toBe(false);
        await expect(crypto.subtle.exportKey('pkcs8', keyPair.privateKey)).rejects.toThrow();
        const signer = await createWebCryptoSigner(keyPair);
        const message = new TextEncoder().encode('hello');
        const signature = await signer.sign(message);
        expect(signature).toHaveLength(64);
        expect(verifyEd25519(signer.publicKey(), message, signature)).toBe(true);
    });

    it('generates extractable keys only on request', async () => {
        const keyPair = await generateEd25519KeyPair({ extractable: true });
        expect(keyPair.privateKey.extractable).toBe(true);
        expect(new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey))).toHaveLength(48);
    });

    it('round-trips an extractable imported seed through PKCS#8', async () => {
        const [vector] = RFC_8032;
        const keyPair = await importEd25519PrivateKey(fromHex(vector.seed), { extractable: true });
        const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
        expect(toHex(pkcs8.subarray(-32))).toBe(vector.seed);
    });

    it.each([0, 31, 33, 64])('refuses a %i-byte seed', async (length) => {
        await expect(importEd25519PrivateKey(new Uint8Array(length), { extractable: false })).rejects.toThrow(
            RangeError,
        );
    });

    it('hands out copies of the public key', async () => {
        const signer = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
        const first = signer.publicKey();
        first.fill(0);
        expect(signer.publicKey()).not.toEqual(first);
    });

    it('honours an aborted signal', async () => {
        const signer = await createWebCryptoSigner(await generateEd25519KeyPair({ extractable: false }));
        const controller = new AbortController();
        controller.abort();
        await expect(signer.sign(new Uint8Array(1), controller.signal)).rejects.toThrow();
        await expect(signer.sign(new Uint8Array(1), new AbortController().signal)).resolves.toHaveLength(64);
    });
});
