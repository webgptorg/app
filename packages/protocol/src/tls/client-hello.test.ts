import { describe, expect, it } from 'vitest';
import { parseClientHello } from './client-hello';
import {
    alpnExtension,
    clientHello,
    clientHelloBody,
    concat,
    extension,
    handshakeMessage,
    latin1,
    paddingExtension,
    record,
    records,
    serverNameExtension,
    u16,
    u24,
    u8,
    withU16Length,
} from './fixtures/build-client-hello';
import { CAPTURED_CLIENT_HELLOS } from './fixtures/captured';

const limits = { maxBytes: 16 * 1024 };

function parse(bytes: Uint8Array): ReturnType<typeof parseClientHello> {
    return parseClientHello(bytes, limits);
}

describe('parseClientHello', () => {
    describe('captured clients', () => {
        it.each(CAPTURED_CLIENT_HELLOS)('$name', ({ bytes, expected }) => {
            expect(parse(bytes)).toEqual(expected);
        });
    });

    describe('server_name', () => {
        it('returns no-sni when the extension is missing', () => {
            expect(parse(clientHello([alpnExtension('h2')]))).toEqual({ kind: 'no-sni', alpn: ['h2'] });
        });

        it('returns no-sni for a hello without any extensions', () => {
            expect(parse(clientHello(undefined))).toEqual({ kind: 'no-sni', alpn: [] });
        });

        it('lowercases the hostname', () => {
            expect(parse(clientHello([serverNameExtension('Engine.EXAMPLE.com')]))).toEqual({
                kind: 'sni',
                hostname: 'engine.example.com',
                alpn: [],
            });
        });

        it('accepts a 253-byte name', () => {
            const name = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
            expect(name).toHaveLength(253);
            expect(parse(clientHello([serverNameExtension(name)]))).toMatchObject({ kind: 'sni', hostname: name });
        });

        it.each([
            ['an empty name', [serverNameExtension('')]],
            ['two names', [serverNameExtension('a.example', 'b.example')]],
            ['a non-ASCII byte', [serverNameExtension(concat(latin1('engine'), u8(0xe9), latin1('.example')))]],
            ['a trailing dot', [serverNameExtension('engine.example.')]],
            ['a leading dot', [serverNameExtension('.engine.example')]],
            ['an empty label', [serverNameExtension('engine..example')]],
            ['an underscore', [serverNameExtension('engine_1.example')]],
            ['a 254-byte name', [serverNameExtension(`${'a'.repeat(63)}.`.repeat(3) + 'b'.repeat(62))]],
            ['no entries', [extension(0, withU16Length(new Uint8Array(0)))]],
            ['an empty extension', [extension(0, new Uint8Array(0))]],
            ['a non-host_name entry', [extension(0, withU16Length(concat(u8(1), withU16Length(latin1('a.example')))))]],
            [
                'a list length that disagrees',
                [extension(0, concat(u16(99), u8(0), withU16Length(latin1('a.example'))))],
            ],
            ['a name length past the list', [extension(0, withU16Length(concat(u8(0), u16(50), latin1('a.example'))))]],
        ])('rejects %s', (_, extensions) => {
            expect(parse(clientHello(extensions))).toEqual({ kind: 'malformed', reason: 'bad-server-name' });
        });
    });

    describe('alpn', () => {
        it('returns every offered protocol in order', () => {
            expect(parse(clientHello([alpnExtension('acme-tls/1', 'h2'), serverNameExtension('a.example')]))).toEqual({
                kind: 'sni',
                hostname: 'a.example',
                alpn: ['acme-tls/1', 'h2'],
            });
        });

        it.each([
            ['an empty list', extension(16, withU16Length(new Uint8Array(0)))],
            ['an empty protocol name', extension(16, withU16Length(concat(u8(0), u8(2), latin1('h2'))))],
            ['a name past the list', extension(16, withU16Length(concat(u8(5), latin1('h2'))))],
            ['a list length that disagrees', extension(16, concat(u16(9), u8(2), latin1('h2')))],
        ])('rejects %s', (_, alpn) => {
            expect(parse(clientHello([alpn]))).toEqual({ kind: 'malformed', reason: 'bad-extensions' });
        });
    });

    describe('extensions', () => {
        it('rejects a duplicate extension', () => {
            expect(
                parse(clientHello([paddingExtension(1), serverNameExtension('a.example'), paddingExtension(2)])),
            ).toEqual({ kind: 'malformed', reason: 'duplicate-extension' });
        });

        it('rejects an extension whose length runs past the end', () => {
            const truncated = concat(u16(21), u16(10), new Uint8Array(4));
            expect(parse(clientHello([serverNameExtension('a.example'), truncated]))).toEqual({
                kind: 'malformed',
                reason: 'bad-extensions',
            });
        });

        it('rejects an extensions block whose length disagrees with the body', () => {
            const body = concat(clientHelloBody(undefined), u16(10), paddingExtension(0));
            expect(parse(records(handshakeMessage(1, body)))).toEqual({ kind: 'malformed', reason: 'bad-extensions' });
        });

        it('ignores unknown extensions, padding and an ECH outer extension', () => {
            const hello = clientHello([
                extension(0x0a0a, new Uint8Array(0)),
                extension(0xfe0d, new Uint8Array(40).fill(7)),
                serverNameExtension('public.example'),
                paddingExtension(300),
            ]);
            expect(parse(hello)).toEqual({ kind: 'sni', hostname: 'public.example', alpn: [] });
        });
    });

    describe('records', () => {
        const hello = handshakeMessage(1, clientHelloBody([serverNameExtension('a.example'), alpnExtension('h2')]));
        const expected = { kind: 'sni', hostname: 'a.example', alpn: ['h2'] };

        it('reassembles a ClientHello split across two records', () => {
            expect(parse(records(hello, [40]))).toEqual(expected);
        });

        it('reassembles a handshake header split across records', () => {
            expect(parse(records(hello, [1, 2, 1, 30]))).toEqual(expected);
        });

        it('ignores bytes after the ClientHello', () => {
            expect(parse(concat(records(hello), record(latin1('early data'), 0x17), latin1('GET /')))).toEqual(
                expected,
            );
        });

        it('accepts record versions 0x0301 to 0x0303', () => {
            for (const version of [0x0301, 0x0302, 0x0303]) {
                expect(parse(record(hello, 0x16, version))).toEqual(expected);
            }
        });

        it.each([
            ['an HTTP request', latin1('GET / HTTP/1.1\r\nHost: a.example\r\n\r\n')],
            ['an SSLv2-style hello', Uint8Array.of(0x80, 0x2e, 0x01, 0x03, 0x01, 0x00, 0x15, 0x00, 0x00, 0x00, 0x10)],
            ['an alert record', record(Uint8Array.of(2, 40), 0x15)],
            [
                'a non-handshake record before the ClientHello completes',
                concat(record(hello.subarray(0, 10)), record(hello.subarray(10), 0x17)),
            ],
        ])('rejects %s as not-handshake', (_, bytes) => {
            expect(parse(bytes)).toEqual({ kind: 'malformed', reason: 'not-handshake' });
        });

        it.each([
            ['SSL 3.0', record(hello, 0x16, 0x0300)],
            ['0x0304', record(hello, 0x16, 0x0304)],
            ['a bad major version', record(hello, 0x16, 0x0201)],
            [
                'a bad version on a later record',
                concat(record(hello.subarray(0, 10)), record(hello.subarray(10), 0x16, 0x0300)),
            ],
        ])('rejects record version %s', (_, bytes) => {
            expect(parse(bytes)).toEqual({ kind: 'malformed', reason: 'unsupported-record-version' });
        });

        it('rejects a ServerHello as not-client-hello', () => {
            expect(parse(records(handshakeMessage(2, clientHelloBody([]))))).toEqual({
                kind: 'malformed',
                reason: 'not-client-hello',
            });
        });

        it.each([
            ['an empty record', concat(record(new Uint8Array(0)), records(hello))],
            ['a record over 2^14 bytes', concat(u8(0x16), u16(0x0301), u16(2 ** 14 + 1), hello)],
            ['a record running past the ClientHello', record(concat(hello, u8(0)))],
            [
                'a later record running past the ClientHello',
                concat(record(hello.subarray(0, 10)), record(concat(hello.subarray(10), u8(0)))),
            ],
            ['a handshake length below the minimum body', record(concat(u8(1), u24(4), new Uint8Array(4)))],
            [
                'a session ID over 32 bytes',
                record(handshakeMessage(1, concat(new Uint8Array(34), u8(33), new Uint8Array(33)))),
            ],
            [
                'an odd cipher suites length',
                record(handshakeMessage(1, concat(new Uint8Array(34), u8(0), u16(3), new Uint8Array(3), u8(1), u8(0)))),
            ],
            [
                'no compression methods',
                record(handshakeMessage(1, concat(new Uint8Array(34), u8(0), u16(2), u16(0x1301), u8(0)))),
            ],
        ])('rejects %s as length-mismatch', (_, bytes) => {
            expect(parse(bytes)).toEqual({ kind: 'malformed', reason: 'length-mismatch' });
        });
    });

    describe('limits', () => {
        const hello = clientHello([serverNameExtension('a.example')]);

        it('parses a complete ClientHello of exactly maxBytes bytes', () => {
            expect(parseClientHello(hello, { maxBytes: hello.length })).toMatchObject({ kind: 'sni' });
        });

        it('returns too-large when the ClientHello is one byte over maxBytes', () => {
            expect(parseClientHello(hello, { maxBytes: hello.length - 1 })).toEqual({ kind: 'too-large' });
        });

        it('returns too-large from a record header alone when the record cannot fit', () => {
            expect(parseClientHello(concat(u8(0x16), u16(0x0301), u16(1000)), { maxBytes: 500 })).toEqual({
                kind: 'too-large',
            });
        });

        it('returns too-large from a handshake header alone when the ClientHello cannot fit', () => {
            const header = record(concat(u8(1), u24(2000)));
            expect(parseClientHello(header, { maxBytes: 1000 })).toEqual({ kind: 'too-large' });
            expect(parseClientHello(header.subarray(0, 9), { maxBytes: 1000 })).toEqual({ kind: 'too-large' });
        });

        it('counts the record headers a fragmented ClientHello still needs', () => {
            // 100 bytes, then 2^14 and the rest: after the first record, two more headers are due.
            const fragmented = records(handshakeMessage(1, clientHelloBody([paddingExtension(20_000)])), [100]);
            const firstRecord = fragmented.subarray(0, 105);
            const exact = fragmented.length;
            expect(parseClientHello(firstRecord, { maxBytes: exact - 1 })).toEqual({ kind: 'too-large' });
            expect(parseClientHello(firstRecord, { maxBytes: exact })).toEqual({ kind: 'need-more' });
            expect(parseClientHello(fragmented, { maxBytes: exact })).toEqual({ kind: 'no-sni', alpn: [] });
        });

        it('returns too-large when maxBytes is reached without a complete ClientHello', () => {
            // Two handshake bytes leave the ClientHello's length unknown, so only the byte count can stop it.
            const firstRecord = record(Uint8Array.of(1, 0));
            const maxBytes = firstRecord.length;
            expect(parseClientHello(firstRecord, { maxBytes: maxBytes + 1 })).toEqual({ kind: 'need-more' });
            expect(parseClientHello(firstRecord, { maxBytes })).toEqual({ kind: 'too-large' });
            expect(parseClientHello(concat(firstRecord, u8(0x16)), { maxBytes })).toEqual({ kind: 'too-large' });
        });

        it('returns need-more for an empty input', () => {
            expect(parse(new Uint8Array(0))).toEqual({ kind: 'need-more' });
        });

        it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('throws on maxBytes %s', (maxBytes) => {
            expect(() => parseClientHello(hello, { maxBytes })).toThrow(RangeError);
        });
    });
});
