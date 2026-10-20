import { describe, expect, it } from 'vitest';

import { createSeededRandom } from '../../testing/seeded-random';
import {
    DerError,
    TAG,
    childrenOf,
    decodeOid,
    explicit,
    oid,
    readDer,
    sequence,
    smallInteger,
    time,
    tlv,
    unsignedInteger,
} from './der';

function hex(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('hex');
}

describe('unsignedInteger', () => {
    it('encodes minimally', () => {
        expect(hex(unsignedInteger(Buffer.of(0)))).toBe('020100');
        expect(hex(unsignedInteger(Buffer.of()))).toBe('020100');
        expect(hex(unsignedInteger(Buffer.of(0, 0, 0)))).toBe('020100');
        expect(hex(unsignedInteger(Buffer.of(0x7f)))).toBe('02017f');
        expect(hex(unsignedInteger(Buffer.of(0x80)))).toBe('02020080');
        expect(hex(unsignedInteger(Buffer.of(0, 0x7f)))).toBe('02017f');
        expect(hex(unsignedInteger(Buffer.of(0, 0x80)))).toBe('02020080');
        expect(hex(unsignedInteger(Buffer.of(0, 0, 0x01, 0x00)))).toBe('02020100');
        expect(hex(smallInteger(2))).toBe('020102');
    });

    // DER (X.690 §8.3.2): the first nine bits of a multi-byte INTEGER are never all zeros or all ones.
    it('never emits a redundant leading byte, whatever the random input', () => {
        const random = createSeededRandom(512);
        const inputs = [
            ...Array.from({ length: 2_000 }, () => random.bytes(16)),
            Uint8Array.of(0, ...random.bytes(15)),
            Uint8Array.of(0, 0x80, ...random.bytes(14)),
            Uint8Array.of(0, 0, 0x01, ...random.bytes(13)),
        ];
        for (const input of inputs) {
            const node = readDer(unsignedInteger(input));
            expect(node.tag).toBe(TAG.integer);
            const [first = 0, second = 0] = node.content;
            if (node.content.length > 1) expect(first === 0 && (second & 0x80) === 0).toBe(false);
            expect(first & 0x80).toBe(0);
            expect(BigInt(`0x${hex(node.content) || '0'}`)).toBe(BigInt(`0x${hex(input) || '0'}`));
        }
    });
});

describe('time', () => {
    it('uses UTCTime through 2049 and GeneralizedTime from 2050, in whole seconds', () => {
        const utc = readDer(time(new Date('2049-12-31T23:59:59.999Z')));
        expect(utc.tag).toBe(TAG.utcTime);
        expect(utc.content.toString('ascii')).toBe('491231235959Z');
        const generalized = readDer(time(new Date('2050-01-01T00:00:00Z')));
        expect(generalized.tag).toBe(TAG.generalizedTime);
        expect(generalized.content.toString('ascii')).toBe('20500101000000Z');
    });
});

describe('tlv lengths', () => {
    it('round-trips short and long forms', () => {
        for (const size of [0, 1, 127, 128, 255, 256, 70_000]) {
            const node = readDer(tlv(TAG.octetString, Buffer.alloc(size, 7)));
            expect(node.content.length).toBe(size);
        }
    });
});

describe('readDer', () => {
    it.each([
        ['empty input', ''],
        ['a tag without length', '30'],
        ['a truncated long length', '3082'],
        ['content past the input', '300301'],
        ['trailing bytes', '3000ff'],
        ['indefinite length', '3080'],
        ['more than four length octets', '3085' + '0000000001'],
        ['a long form for a short length', '30817f' + '00'.repeat(127)],
        ['a long form with a leading zero octet', '3082' + '0080' + '00'.repeat(128)],
        ['a multi-byte tag', '1f0100'],
    ])('rejects %s', (_name, input) => {
        expect(() => readDer(Buffer.from(input, 'hex'))).toThrow(DerError);
    });

    it('reads a node from a view into a larger buffer', () => {
        const backing = Buffer.concat([Buffer.of(0xaa, 0xbb), sequence(smallInteger(5))]);
        const node = readDer(backing.subarray(2));
        expect(childrenOf(node).map((child) => hex(child.encoded))).toEqual(['020105']);
    });
});

describe('childrenOf', () => {
    it('lists the elements of constructed nodes, including context-tagged ones', () => {
        const node = readDer(sequence(smallInteger(1), explicit(3, sequence()), oid('2.5.29.30')));
        expect(childrenOf(node).map((child) => child.tag)).toEqual([TAG.integer, 0xa3, TAG.oid]);
    });

    it('rejects a primitive node and a malformed child', () => {
        expect(() => childrenOf(readDer(smallInteger(1)))).toThrow(DerError);
        expect(() => childrenOf(readDer(Buffer.from('3002' + '0205', 'hex')))).toThrow(DerError);
    });
});

describe('decodeOid', () => {
    it.each(['2.5.29.30', '1.2.840.10045.4.3.2', '1.3.6.1.5.5.7.3.1', '0.9.2342.19200300.100.1.25'])(
        'round-trips %s',
        (dotted) => {
            expect(decodeOid(readDer(oid(dotted)))).toBe(dotted);
        },
    );

    it('rejects anything but a non-empty OBJECT IDENTIFIER', () => {
        expect(() => decodeOid(readDer(smallInteger(1)))).toThrow(DerError);
        expect(() => decodeOid(readDer(tlv(TAG.oid)))).toThrow(DerError);
    });
});
