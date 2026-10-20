import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from './base64url';
import type { Ed25519PublicKey, EngineId, Hostname, RelayId } from './ids';
import {
    Ed25519PublicKey as Ed25519PublicKeySchema,
    Ed25519Signature,
    EngineId as EngineIdSchema,
    EngineVersion,
    Hostname as HostnameSchema,
    RelayId as RelayIdSchema,
    Timestamp,
    ed25519PublicKeyFromBytes,
    ed25519PublicKeyToBytes,
    ed25519SignatureFromBytes,
    ed25519SignatureToBytes,
} from './ids';

const label = (length: number, char = 'a'): string => char.repeat(length);

describe('Hostname', () => {
    it.each([
        ['example.com', 'example.com'],
        ['EXAMPLE.Com', 'example.com'],
        ['Relay-FSN.Example.NET', 'relay-fsn.example.net'],
        ['a.b', 'a.b'],
        ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
        ['123.example.com', '123.example.com'],
        ['a1-b2.c3', 'a1-b2.c3'],
        [`${label(63)}.example`, `${label(63)}.example`],
        [
            [label(63), label(63), label(63), label(61)].join('.'),
            [label(63), label(63), label(63), label(61)].join('.'),
        ],
    ])('accepts %j as %j', (input, expected) => {
        expect(HostnameSchema.parse(input)).toBe(expected);
    });

    it.each([
        ['empty', ''],
        ['trailing dot', 'example.com.'],
        ['leading dot', '.example.com'],
        ['empty label', 'a..example'],
        ['64-character label', `${label(64)}.example`],
        ['254-character name', [label(63), label(63), label(63), label(62)].join('.')],
        ['leading hyphen', '-a.example'],
        ['trailing hyphen', 'a-.example'],
        ['leading hyphen in the last label', 'a.-example'],
        ['trailing hyphen in the last label', 'a.example-'],
        ['underscore', '_acme-challenge.example.com'],
        ['underscore inside a label', 'a_b.example'],
        ['Unicode (IDN as U-label)', 'bücher.example'],
        ['Kelvin sign, which lowercases to ASCII k', 'Kexample.com'],
        ['long s, which uppercases to ASCII S', 'ſexample.com'],
        ['dotless i', 'example.ıo'],
        ['IPv4 literal', '127.0.0.1'],
        ['IPv4 literal, short form', '127.1'],
        ['all-numeric last label', 'example.123'],
        ['hex last label', 'example.0x7f'],
        ['bare 0x last label', 'example.0X'],
        ['IPv6 literal', '[::1]'],
        ['IPv6 literal without brackets', '::1'],
        ['single label', 'localhost'],
        ['port', 'example.com:443'],
        ['space', 'exa mple.com'],
        ['surrounding whitespace', ' example.com'],
        ['slash', 'example.com/x'],
    ])('rejects %s', (_, input) => {
        expect(HostnameSchema.safeParse(input).success).toBe(false);
    });

    it('rejects non-strings', () => {
        expect(HostnameSchema.safeParse(42).success).toBe(false);
        expect(HostnameSchema.safeParse(null).success).toBe(false);
    });
});

describe('RelayId', () => {
    it('follows the Hostname rules', () => {
        expect(RelayIdSchema.parse('Relay-FSN.example.net')).toBe('relay-fsn.example.net');
        expect(RelayIdSchema.safeParse('relay').success).toBe(false);
        expect(RelayIdSchema.safeParse('127.0.0.1').success).toBe(false);
    });
});

describe('EngineId', () => {
    it('accepts 26 lowercase base32 characters', () => {
        expect(EngineIdSchema.parse('eh7ddx5bksrgcytl7bkai36se4')).toBe('eh7ddx5bksrgcytl7bkai36se4');
        expect(EngineIdSchema.parse('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghijklmnopqrstuvwxyz');
    });

    it.each([
        ['25 characters', 'a'.repeat(25)],
        ['27 characters', 'a'.repeat(27)],
        ['uppercase', 'EH7DDX5BKSRGCYTL7BKAI36SE4'],
        ['digit outside the alphabet', 'eh7ddx5bksrgcytl7bkai36se1'],
        ['padding', 'eh7ddx5bksrgcytl7bkai36se='],
        ['hyphen', 'eh7ddx5bksrgcytl7bkai36se-'],
    ])('rejects %s', (_, input) => {
        expect(EngineIdSchema.safeParse(input).success).toBe(false);
    });
});

describe('EngineVersion', () => {
    it.each(['1.8.2', '0.0.0', '10.20.30', '1.0.0-alpha.1', '1.0.0-0.3.7', '1.0.0+build.5', '1.0.0-rc.1+sha.5114f85'])(
        'accepts %s',
        (input) => {
            expect(EngineVersion.parse(input)).toBe(input);
        },
    );

    it.each([
        '1.8',
        'v1.8.2',
        '01.2.3',
        '1.02.3',
        '1.2.3-01',
        '1.2.3-',
        '1.2.3+',
        '1.2.3 ',
        '',
        `1.2.3-${'a'.repeat(300)}`,
    ])('rejects %j', (input) => {
        expect(EngineVersion.safeParse(input).success).toBe(false);
    });
});

describe('Timestamp', () => {
    it.each(['2026-10-16T12:00:00Z', '2026-10-16T12:00:00.123Z', '2026-10-16T12:00:00.123456789Z'])(
        'accepts %s',
        (input) => {
            expect(Timestamp.parse(input)).toBe(input);
        },
    );

    it.each([
        '2026-10-16T12:00:00+02:00',
        '2026-10-16T12:00:00',
        '2026-10-16 12:00:00Z',
        '2026-10-16',
        '2026-13-01T00:00:00Z',
        '2026-10-16T24:00:00Z',
        'yesterday',
    ])('rejects %s', (input) => {
        expect(Timestamp.safeParse(input).success).toBe(false);
    });
});

describe('Ed25519 wire forms', () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => index * 7);
    const signature = Uint8Array.from({ length: 64 }, (_, index) => 255 - index);

    it('converts public keys both ways', () => {
        const wire = ed25519PublicKeyFromBytes(key);
        expect(wire).toBe(encodeBase64Url(key));
        expect(wire).toHaveLength(43);
        expect(Ed25519PublicKeySchema.parse(wire)).toBe(wire);
        expect(ed25519PublicKeyToBytes(wire)).toEqual(key);
    });

    it('converts signatures both ways', () => {
        const wire = ed25519SignatureFromBytes(signature);
        expect(wire).toHaveLength(86);
        expect(Ed25519Signature.parse(wire)).toBe(wire);
        expect(ed25519SignatureToBytes(wire)).toEqual(signature);
    });

    it('refuses bytes of the wrong length', () => {
        expect(() => ed25519PublicKeyFromBytes(new Uint8Array(31))).toThrow(RangeError);
        expect(() => ed25519PublicKeyFromBytes(new Uint8Array(33))).toThrow(RangeError);
        expect(() => ed25519PublicKeyFromBytes(new Uint8Array(64))).toThrow(RangeError);
        expect(() => ed25519SignatureFromBytes(new Uint8Array(63))).toThrow(RangeError);
        expect(() => ed25519SignatureFromBytes(new Uint8Array(32))).toThrow(RangeError);
    });

    it('rejects anything but canonical base64url of the exact length', () => {
        const wireKey = encodeBase64Url(key);
        const wireSignature = encodeBase64Url(signature);
        for (const input of [
            wireKey.slice(0, -1),
            `${wireKey}A`,
            `${wireKey}=`,
            wireKey.replace(/.$/, 'B'),
            encodeBase64Url(new Uint8Array(31)),
            encodeBase64Url(new Uint8Array(33)),
            wireSignature,
            wireKey.replace(/.$/, '+'),
            `ed25519:${wireKey}`,
        ]) {
            expect(Ed25519PublicKeySchema.safeParse(input).success, input).toBe(false);
        }
        for (const input of [
            wireSignature.slice(0, -1),
            `${wireSignature}==`,
            wireSignature.replace(/.$/, 'B'),
            wireKey,
            encodeBase64Url(new Uint8Array(65)),
            `ed25519=${wireSignature}`,
        ]) {
            expect(Ed25519Signature.safeParse(input).success, input).toBe(false);
        }
    });

    it('fails loudly on a forged brand', () => {
        expect(() => ed25519PublicKeyToBytes('not base64url!' as Ed25519PublicKey)).toThrow(TypeError);
    });
});

describe('brands', () => {
    it('can only be created through a schema or parser', () => {
        // @ts-expect-error a plain string is not an EngineId
        const engineId: EngineId = 'eh7ddx5bksrgcytl7bkai36se4';
        // @ts-expect-error a plain string is not a Hostname
        const hostname: Hostname = 'example.com';
        const parsed = HostnameSchema.parse('relay.example.com');
        // @ts-expect-error a Hostname is not a RelayId
        const relayId: RelayId = parsed;
        // @ts-expect-error a plain string is not an Ed25519PublicKey
        const publicKey: Ed25519PublicKey = 'AAAA';
        expect([engineId, hostname, relayId, publicKey]).toHaveLength(4);
    });
});
