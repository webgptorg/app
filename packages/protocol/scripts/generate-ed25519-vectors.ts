// Writes src/ed25519-vectors.json: the strict-verification edge cases every implementation of the protocol must
// accept or reject exactly as `verifyEd25519` does (ADR 0014).
//
//   node packages/protocol/scripts/generate-ed25519-vectors.ts
//
// `valid` is noble's actual result with `{ zip215: false }`. Each vector also states the result the protocol's rule
// predicts (small-order A rejected; non-canonical A or R, including negative zero, rejected; S >= L rejected;
// small- or mixed-order R and mixed-order A accepted when the cofactored equation holds), and the script refuses to
// write the file if noble disagrees, so a noble upgrade cannot silently change the rule.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, numberToBytesLE } from '@noble/curves/utils.js';

interface Vector {
    readonly id: string;
    readonly description: string;
    readonly publicKey: string;
    readonly message: string;
    readonly signature: string;
    readonly valid: boolean;
    readonly libsodium?: string;
}

interface Case extends Omit<Vector, 'valid'> {
    readonly expected: boolean;
}

const { Point } = ed25519;
const L = Point.Fn.ORDER;

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const fromHex = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'hex'));
const sha512 = (...parts: Uint8Array[]): Uint8Array => {
    const hash = createHash('sha512');
    for (const part of parts) hash.update(part);
    return new Uint8Array(hash.digest());
};
const scalarOf = (bytes: Uint8Array): bigint => bytesToNumberLE(bytes) % L;
const challenge = (r: Uint8Array, a: Uint8Array, message: Uint8Array): bigint => scalarOf(sha512(r, a, message));

// "Taming the many EdDSAs" (Chalkias, Garillot, Nikolaenko, SSR 2020), cases.json and the condition table from
// https://github.com/novifinancial/ed25519-speccheck at commit 65519336fda78a3d016e947df6d82848aca0c9da.
// The libsodium column of that README accepts only case 3.
const SPECCHECK_SOURCE = 'ed25519-speccheck@65519336 cases.json';
const speccheck: readonly Case[] = [
    {
        id: 'speccheck-0',
        description: `${SPECCHECK_SOURCE} #0: S = 0, small-order A, small-order R`,
        message: '8c93255d71dcab10e8f379c26200f3c7bd5f09d9bc3068d3ef4edeb4853022b6',
        publicKey: 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
        signature:
            'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a0000000000000000000000000000000000000000000000000000000000000000',
        expected: false,
    },
    {
        id: 'speccheck-1',
        description: `${SPECCHECK_SOURCE} #1: 0 < S < L, small-order A, mixed-order R`,
        message: '9bd9f44f4dcc75bd531b56b2cd280b0bb38fc1cd6d1230e14861d861de092e79',
        publicKey: 'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
        signature:
            'f7badec5b8abeaf699583992219b7b223f1df3fbbea919844e3f7c554a43dd43a5bb704786be79fc476f91d3f3f89b03984d8068dcf1bb7dfc6637b45450ac04',
        expected: false,
    },
    {
        id: 'speccheck-2',
        description: `${SPECCHECK_SOURCE} #2: 0 < S < L, mixed-order A, small-order R`,
        message: 'aebf3f2601a0c8c5d39cc7d8911642f740b78168218da8471772b35f9d35b9ab',
        publicKey: 'f7badec5b8abeaf699583992219b7b223f1df3fbbea919844e3f7c554a43dd43',
        signature:
            'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa8c4bd45aecaca5b24fb97bc10ac27ac8751a7dfe1baff8b953ec9f5833ca260e',
        expected: true,
        libsodium: 'rejects (small-order R)',
    },
    {
        id: 'speccheck-3',
        description: `${SPECCHECK_SOURCE} #3: 0 < S < L, mixed-order A and R, passes cofactored and cofactorless`,
        message: '9bd9f44f4dcc75bd531b56b2cd280b0bb38fc1cd6d1230e14861d861de092e79',
        publicKey: 'cdb267ce40c5cd45306fa5d2f29731459387dbf9eb933b7bd5aed9a765b88d4d',
        signature:
            '9046a64750444938de19f227bb80485e92b83fdb4b6506c160484c016cc1852f87909e14428a7a1d62e9f22f3d3ad7802db02eb2e688b6c52fcd6648a98bd009',
        expected: true,
    },
    {
        id: 'speccheck-4',
        description: `${SPECCHECK_SOURCE} #4: 0 < S < L, mixed-order A and R, passes cofactored only`,
        message: 'e47d62c63f830dc7a6851a0b1f33ae4bb2f507fb6cffec4011eaccd55b53f56c',
        publicKey: 'cdb267ce40c5cd45306fa5d2f29731459387dbf9eb933b7bd5aed9a765b88d4d',
        signature:
            '160a1cb0dc9c0258cd0a7d23e94d8fa878bcb1925f2c64246b2dee1796bed5125ec6bc982a269b723e0668e540911a9a6a58921d6925e434ab10aa7940551a09',
        expected: true,
        libsodium: 'rejects (cofactorless equation)',
    },
    {
        id: 'speccheck-5',
        description: `${SPECCHECK_SOURCE} #5: 0 < S < L, mixed-order A, prime-order R, fails if 8h is pre-reduced`,
        message: 'e47d62c63f830dc7a6851a0b1f33ae4bb2f507fb6cffec4011eaccd55b53f56c',
        publicKey: 'cdb267ce40c5cd45306fa5d2f29731459387dbf9eb933b7bd5aed9a765b88d4d',
        signature:
            '21122a84e0b5fca4052f5b1235c80a537878b38f3142356b2c2384ebad4668b7e40bc836dac0f71076f9abe3a53f9c03c1ceeeddb658d0030494ace586687405',
        expected: true,
        libsodium: 'rejects (cofactorless equation)',
    },
    {
        id: 'speccheck-6',
        description: `${SPECCHECK_SOURCE} #6: S > L, prime-order A and R`,
        message: '85e241a07d148b41e47d62c63f830dc7a6851a0b1f33ae4bb2f507fb6cffec40',
        publicKey: '442aad9f089ad9e14647b1ef9099a1ff4798d78589e66f28eca69c11f582a623',
        signature:
            'e96f66be976d82e60150baecff9906684aebb1ef181f67a7189ac78ea23b6c0e547f7690a0e2ddcd04d87dbc3490dc19b3b3052f7ff0538cb68afb369ba3a514',
        expected: false,
    },
    {
        id: 'speccheck-7',
        description: `${SPECCHECK_SOURCE} #7: S >> L (no canonical encoding with a clear high bit), prime-order A and R`,
        message: '85e241a07d148b41e47d62c63f830dc7a6851a0b1f33ae4bb2f507fb6cffec40',
        publicKey: '442aad9f089ad9e14647b1ef9099a1ff4798d78589e66f28eca69c11f582a623',
        signature:
            '8ce5b96c8f26d0ab6c47958c9e68b937104cd36e13c33566acd2fe8d38aa19427e71f98a473474f2f13f06f97c20d58cc3f54b8bd0d272f42b695dd7e89a8c22',
        expected: false,
    },
    {
        id: 'speccheck-8',
        description: `${SPECCHECK_SOURCE} #8: non-canonical R: (0, -1) with the x sign bit set (negative zero), reduced for the hash`,
        message: '9bedc267423725d473888631ebf45988bad3db83851ee85c85e241a07d148b41',
        publicKey: 'f7badec5b8abeaf699583992219b7b223f1df3fbbea919844e3f7c554a43dd43',
        signature:
            'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff03be9678ac102edcd92b0210bb34d7428d12ffc5df5f37e359941266a4e35f0f',
        expected: false,
    },
    {
        id: 'speccheck-9',
        description: `${SPECCHECK_SOURCE} #9: non-canonical R: (0, -1) with the x sign bit set (negative zero), not reduced for the hash`,
        message: '9bedc267423725d473888631ebf45988bad3db83851ee85c85e241a07d148b41',
        publicKey: 'f7badec5b8abeaf699583992219b7b223f1df3fbbea919844e3f7c554a43dd43',
        signature:
            'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffca8c5b64cd208982aa38d4936621a4775aa233aa0505711d8fdcfdaa943d4908',
        expected: false,
    },
    {
        id: 'speccheck-10',
        description: `${SPECCHECK_SOURCE} #10: non-canonical small-order A: (0, -1) with the x sign bit set (negative zero), reduced for the hash`,
        message: 'e96b7021eb39c1a163b6da4e3093dcd3f21387da4cc4572be588fafae23c155b',
        publicKey: 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        signature:
            'a9d55260f765261eb9b84e106f665e00b867287a761990d7135963ee0a7d59dca5bb704786be79fc476f91d3f3f89b03984d8068dcf1bb7dfc6637b45450ac04',
        expected: false,
    },
    {
        id: 'speccheck-11',
        description: `${SPECCHECK_SOURCE} #11: non-canonical small-order A: (0, -1) with the x sign bit set (negative zero), not reduced for the hash`,
        message: '39a591f5321bbe07fd5a23dc2f39d025d74526615746727ceefd6e82ae65c06f',
        publicKey: 'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
        signature:
            'a9d55260f765261eb9b84e106f665e00b867287a761990d7135963ee0a7d59dca5bb704786be79fc476f91d3f3f89b03984d8068dcf1bb7dfc6637b45450ac04',
        expected: false,
    },
];

// RFC 8032 §7.1 TEST 1, the base for the S range vectors.
const RFC_PUBLIC_KEY = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
const RFC_SIGNATURE =
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
const rfcR = fromHex(RFC_SIGNATURE.slice(0, 64));
const rfcS = bytesToNumberLE(fromHex(RFC_SIGNATURE.slice(64)));

// A full-order key with a known scalar, so signatures with a chosen R can be built without the RFC 8032 nonce.
const MESSAGE = new TextEncoder().encode('ptbk ed25519 edge case');
const secret = scalarOf(sha512(new TextEncoder().encode('ptbk-ed25519-vectors key')));
const publicKey = Point.BASE.multiply(secret).toBytes();
const IDENTITY = fromHex('0100000000000000000000000000000000000000000000000000000000000000');
const IDENTITY_NEGATIVE_ZERO = fromHex('0100000000000000000000000000000000000000000000000000000000000080');
const IDENTITY_Y_ABOVE_P = fromHex('eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f');

/** A signature that satisfies the equation for `rBytes` = R with discrete log `r` (0 for the identity). */
function signWithR(rBytes: Uint8Array, r: bigint, a: bigint, aBytes: Uint8Array): Uint8Array {
    const s = (r + challenge(rBytes, aBytes, MESSAGE) * a) % L;
    return new Uint8Array([...rBytes, ...numberToBytesLE(s, 32)]);
}

const constructed: readonly Case[] = [
    {
        id: 'small-order-r-identity',
        description: 'R is the identity (small order, canonical), full-order A, equation holds',
        publicKey: hex(publicKey),
        message: hex(MESSAGE),
        signature: hex(signWithR(IDENTITY, 0n, secret, publicKey)),
        expected: true,
        libsodium: 'rejects (small-order R)',
    },
    {
        id: 'non-canonical-r-negative-zero',
        description:
            'R is the identity encoded with the x sign bit set (negative zero), equation holds for the decoded point',
        publicKey: hex(publicKey),
        message: hex(MESSAGE),
        signature: hex(signWithR(IDENTITY_NEGATIVE_ZERO, 0n, secret, publicKey)),
        expected: false,
    },
    {
        id: 'small-order-a-identity',
        description: 'A is the identity (small order, canonical), R = rB and S = r, so the equation holds',
        publicKey: hex(IDENTITY),
        message: hex(MESSAGE),
        signature: hex(signWithR(Point.BASE.multiply(7n).toBytes(), 7n, 0n, IDENTITY)),
        expected: false,
    },
    {
        id: 'non-canonical-a-negative-zero-identity',
        description: 'A is the identity encoded with the x sign bit set (negative zero)',
        publicKey: hex(IDENTITY_NEGATIVE_ZERO),
        message: hex(MESSAGE),
        signature: hex(signWithR(Point.BASE.multiply(7n).toBytes(), 7n, 0n, IDENTITY_NEGATIVE_ZERO)),
        expected: false,
    },
    {
        id: 'non-canonical-r-y-above-p',
        description: 'R is the identity encoded as y = p + 1, equation holds for the decoded point',
        publicKey: hex(publicKey),
        message: hex(MESSAGE),
        signature: hex(signWithR(IDENTITY_Y_ABOVE_P, 0n, secret, publicKey)),
        expected: false,
    },
    {
        id: 'non-canonical-a-y-above-p',
        description: 'A is the identity encoded as y = p + 1, R = rB and S = r, so the equation holds',
        publicKey: hex(IDENTITY_Y_ABOVE_P),
        message: hex(MESSAGE),
        signature: hex(signWithR(Point.BASE.multiply(7n).toBytes(), 7n, 0n, IDENTITY_Y_ABOVE_P)),
        expected: false,
    },
    {
        id: 's-equals-l-plus-s',
        description: 'RFC 8032 TEST 1 with S replaced by S + L (S >= L, equation holds mod L)',
        publicKey: RFC_PUBLIC_KEY,
        message: '',
        signature: hex(new Uint8Array([...rfcR, ...numberToBytesLE(rfcS + L, 32)])),
        expected: false,
    },
    {
        id: 's-equals-l',
        description: 'RFC 8032 TEST 1 with S = L',
        publicKey: RFC_PUBLIC_KEY,
        message: '',
        signature: hex(new Uint8Array([...rfcR, ...numberToBytesLE(L, 32)])),
        expected: false,
    },
    {
        id: 's-just-below-l',
        description:
            'RFC 8032 TEST 1 with S = L - 1: passes the range check and fails only the equation (a valid signature with a chosen S cannot be built)',
        publicKey: RFC_PUBLIC_KEY,
        message: '',
        signature: hex(new Uint8Array([...rfcR, ...numberToBytesLE(L - 1n, 32)])),
        expected: false,
    },
];

const vectors: Vector[] = [...speccheck, ...constructed].map(({ expected, ...vector }) => {
    const valid = ed25519.verify(fromHex(vector.signature), fromHex(vector.message), fromHex(vector.publicKey), {
        zip215: false,
    });
    if (valid !== expected)
        throw new Error(`${vector.id}: noble says ${String(valid)}, the rule says ${String(expected)}`);
    return { ...vector, valid };
});

const document = {
    description:
        'Ed25519 strict-verification reference for the Promptbook protocol (ADR 0014). `valid` is the result of @noble/curves 2.4.0 ed25519.verify(signature, message, publicKey, { zip215: false }); every implementation must match it. Hex encoded. Generated by packages/protocol/scripts/generate-ed25519-vectors.ts.',
    rule: 'Canonical A and R (y < p, no negative zero), S < L, A not of small order, then the cofactored equation [8][S]B = [8]R + [8][k]A. Small- or mixed-order R and mixed-order A are accepted when the equation holds.',
    vectors,
};

writeFileSync(join(import.meta.dirname, '..', 'src', 'ed25519-vectors.json'), `${JSON.stringify(document, null, 2)}\n`);
