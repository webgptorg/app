import { describe, expect, it } from 'vitest';

import { concat } from './testing/pcap-writer.ts';
import {
    ALERT,
    APPLICATION_DATA,
    CHANGE_CIPHER_SPEC,
    HANDSHAKE,
    clientHello,
    opaqueBytes,
    tls13ClientFlight,
    tlsRecord,
} from './testing/tls-fixtures.ts';
import { checkTlsStream, scanTlsRecords } from './tls-records.ts';

describe('scanTlsRecords', () => {
    it('lists every record of a well-formed stream', () => {
        const hello = clientHello('engine.test');
        const stream = concat([hello, tlsRecord(CHANGE_CIPHER_SPEC, Uint8Array.of(1)), tlsRecord(23, opaqueBytes(40))]);

        expect(scanTlsRecords(stream)).toEqual({
            records: [
                { contentType: HANDSHAKE, version: 0x0301, length: hello.byteLength - 5, offset: 0 },
                { contentType: CHANGE_CIPHER_SPEC, version: 0x0303, length: 1, offset: hello.byteLength },
                { contentType: APPLICATION_DATA, version: 0x0303, length: 40, offset: hello.byteLength + 6 },
            ],
            outcome: { kind: 'records' },
        });
    });

    it.each([
        ['content type 24 (heartbeat)', Uint8Array.of(24, 3, 3, 0, 1, 0), 'content-type'],
        ['content type 19', Uint8Array.of(19, 3, 3, 0, 1, 0), 'content-type'],
        ['plaintext HTTP', new TextEncoder().encode('GET / HTTP/1.1\r\n'), 'content-type'],
        ['major version 2', Uint8Array.of(23, 2, 3, 0, 1, 0), 'version'],
        ['SSL 3.0', Uint8Array.of(23, 3, 0, 0, 1, 0), 'version'],
        ['minor version 5', Uint8Array.of(23, 3, 5, 0, 1, 0), 'version'],
        ['zero length', Uint8Array.of(23, 3, 3, 0, 0), 'length'],
        ['length above 2^14 + 2048', Uint8Array.of(23, 3, 3, 0x48, 0x01), 'length'],
        ['a length high byte that alone is too large', Uint8Array.of(23, 3, 3, 0x49), 'length'],
    ] as const)('rejects %s', (_, bytes, reason) => {
        expect(scanTlsRecords(bytes).outcome).toEqual({ kind: 'malformed', offset: 0, reason });
    });

    it('reports the offset of a malformed record after valid ones', () => {
        const valid = tlsRecord(APPLICATION_DATA, opaqueBytes(10));

        expect(scanTlsRecords(concat([valid, Uint8Array.of(0x47, 0x45)]))).toEqual({
            records: [{ contentType: APPLICATION_DATA, version: 0x0303, length: 10, offset: 0 }],
            outcome: { kind: 'malformed', offset: 15, reason: 'content-type' },
        });
    });

    it('accepts the maximum record length', () => {
        const record = tlsRecord(APPLICATION_DATA, opaqueBytes(2 ** 14 + 2048));

        expect(scanTlsRecords(record).outcome).toEqual({ kind: 'records' });
    });

    it.each([
        ['inside a record body', tlsRecord(APPLICATION_DATA, opaqueBytes(100)).subarray(0, 50)],
        ['inside a header', Uint8Array.of(23, 3, 3, 0x40)],
        ['after the first header byte', Uint8Array.of(23)],
    ])('reports a stream ending %s as truncated', (_, tail) => {
        const head = tlsRecord(APPLICATION_DATA, opaqueBytes(7));
        const scan = scanTlsRecords(concat([head, tail]));

        expect(scan.records).toHaveLength(1);
        expect(scan.outcome).toEqual({ kind: 'truncated', offset: 12 });
    });
});

describe('checkTlsStream', () => {
    it('accepts a TLS 1.3 flight and counts its record types', () => {
        expect(checkTlsStream(tls13ClientFlight('engine.test', [100, 200, 30]))).toEqual({
            kind: 'tls',
            counts: { changeCipherSpec: 1, alert: 0, handshake: 1, applicationData: 3 },
            truncatedTail: false,
        });
    });

    it('accepts change_cipher_spec and alerts before the first application data', () => {
        const stream = concat([
            tlsRecord(HANDSHAKE, opaqueBytes(10)),
            tlsRecord(CHANGE_CIPHER_SPEC, Uint8Array.of(1)),
            tlsRecord(ALERT, opaqueBytes(2)),
        ]);

        expect(checkTlsStream(stream).kind).toBe('tls');
    });

    it.each([
        ['handshake', HANDSHAKE],
        ['change_cipher_spec', CHANGE_CIPHER_SPEC],
        ['alert', ALERT],
    ])('rejects a %s record after application data', (_, contentType) => {
        const stream = concat([
            tlsRecord(HANDSHAKE, opaqueBytes(10)),
            tlsRecord(APPLICATION_DATA, opaqueBytes(10)),
            tlsRecord(contentType, opaqueBytes(10)),
            tlsRecord(APPLICATION_DATA, opaqueBytes(10)),
        ]);

        const check = checkTlsStream(stream);

        expect(check).toMatchObject({
            kind: 'invalid',
            problem: {
                reason: 'after-application-data',
                offset: 30,
                description: 'record at offset 30 is not application data but follows application data',
            },
        });
    });

    it('rejects an empty stream', () => {
        expect(checkTlsStream(new Uint8Array(0), { allowTruncatedTail: true })).toMatchObject({
            kind: 'invalid',
            problem: { reason: 'empty', offset: 0 },
        });
    });

    it('rejects a stream with only a partial record even when truncation is allowed', () => {
        const partial = tlsRecord(HANDSHAKE, opaqueBytes(10)).subarray(0, 8);

        expect(checkTlsStream(partial, { allowTruncatedTail: true })).toMatchObject({
            kind: 'invalid',
            problem: { reason: 'empty' },
        });
    });

    it('accepts a truncated tail only when allowed', () => {
        const stream = tls13ClientFlight('engine.test', [100]).subarray(0, -20);
        const offset = clientHello('engine.test').byteLength + 6;

        expect(checkTlsStream(stream)).toMatchObject({
            kind: 'invalid',
            problem: {
                reason: 'truncated',
                offset,
                description: `stream ends inside the record at offset ${String(offset)}`,
            },
        });
        expect(checkTlsStream(stream, { allowTruncatedTail: true })).toMatchObject({
            kind: 'tls',
            truncatedTail: true,
        });
    });

    it('rejects a plaintext record type and describes it without the offending byte', () => {
        const stream = concat([tlsRecord(HANDSHAKE, opaqueBytes(10)), new TextEncoder().encode('GET / HTTP/1.1')]);

        expect(checkTlsStream(stream, { allowTruncatedTail: true })).toEqual({
            kind: 'invalid',
            counts: { changeCipherSpec: 0, alert: 0, handshake: 1, applicationData: 0 },
            problem: {
                reason: 'content-type',
                offset: 15,
                description: 'record header at offset 15 has a content type outside 20-23',
            },
        });
    });

    it.each([
        ['version', Uint8Array.of(23, 3, 7, 0, 1, 0), 'record header at offset 0 has a version outside 3.1-3.4'],
        ['length', Uint8Array.of(23, 3, 3, 0, 0), 'record header at offset 0 has a length outside 1-18432'],
    ])('describes a bad %s', (reason, bytes, description) => {
        expect(checkTlsStream(bytes)).toMatchObject({ kind: 'invalid', problem: { reason, offset: 0, description } });
    });
});
