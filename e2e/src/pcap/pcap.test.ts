import { describe, expect, it } from 'vitest';

import type { Endpoint, PcapParse, TcpSegment } from './pcap.ts';
import { formatEndpoint, parsePcap } from './pcap.ts';
import type { PcapWriterOptions, TestPacket } from './testing/pcap-writer.ts';
import { buildPcap, concat } from './testing/pcap-writer.ts';

const CLIENT: Endpoint = { address: '10.0.0.5', port: 51234 };
const SERVER: Endpoint = { address: '10.0.0.11', port: 443 };
const PAYLOAD = new TextEncoder().encode('opaque bytes');

const DATA_PACKET: TestPacket = {
    source: CLIENT,
    destination: SERVER,
    seq: 0xfffffff0,
    flags: { ack: true },
    payload: PAYLOAD,
    timestampUs: 1_700_000_000_123_456,
};

function segments(parse: PcapParse): readonly TcpSegment[] {
    if (parse.kind !== 'ok') throw new Error(`unexpected ${parse.reason}`);
    return parse.segments;
}

describe('parsePcap', () => {
    it.each<[string, PcapWriterOptions]>([
        ['little-endian microsecond', { littleEndian: true }],
        ['big-endian microsecond', { littleEndian: false }],
        ['little-endian nanosecond', { littleEndian: true, nanoseconds: true }],
        ['big-endian nanosecond', { littleEndian: false, nanoseconds: true }],
    ])('decodes a %s capture', (_, options) => {
        expect(parsePcap(buildPcap([DATA_PACKET], options))).toEqual({
            kind: 'ok',
            linkType: 'ethernet',
            segments: [
                {
                    timestampUs: 1_700_000_000_123_456,
                    source: CLIENT,
                    destination: SERVER,
                    seq: 0xfffffff0,
                    flags: { syn: false, ack: true, fin: false, rst: false },
                    payload: PAYLOAD,
                },
            ],
            truncatedPackets: 0,
            malformedPackets: 0,
        });
    });

    it('decodes TCP flags', () => {
        const parse = parsePcap(
            buildPcap([
                { ...DATA_PACKET, flags: { syn: true }, payload: new Uint8Array(0) },
                { ...DATA_PACKET, flags: { fin: true, rst: true } },
            ]),
        );

        expect(segments(parse).map((segment) => segment.flags)).toEqual([
            { syn: true, ack: false, fin: false, rst: false },
            { syn: false, ack: false, fin: true, rst: true },
        ]);
    });

    it.each<[string, NonNullable<PcapWriterOptions['linkType']>, string]>([
        ['Linux cooked v1', 'linux-sll', 'linux-sll'],
        ['Linux cooked v2', 'linux-sll2', 'linux-sll2'],
        ['raw IP', 'raw', 'raw'],
    ])('decodes %s frames', (_, linkType, expected) => {
        const parse = parsePcap(buildPcap([DATA_PACKET], { linkType }));

        expect(parse).toMatchObject({ kind: 'ok', linkType: expected });
        expect(segments(parse)[0]?.payload).toEqual(PAYLOAD);
    });

    it('skips one 802.1Q VLAN tag', () => {
        expect(segments(parsePcap(buildPcap([{ ...DATA_PACKET, vlanTag: true }])))[0]?.payload).toEqual(PAYLOAD);
    });

    it('honours IP and TCP option lengths', () => {
        const parse = parsePcap(buildPcap([{ ...DATA_PACKET, ipOptionBytes: 8, tcpOptionBytes: 12 }]));

        expect(segments(parse)[0]?.payload).toEqual(PAYLOAD);
    });

    it('keeps Ethernet padding out of the payload', () => {
        const parse = parsePcap(
            buildPcap([
                { ...DATA_PACKET, payload: new Uint8Array(0), trailer: new Uint8Array(6).fill(0x41) },
                { ...DATA_PACKET, payload: Uint8Array.of(1, 2), trailer: new Uint8Array(4).fill(0x41) },
            ]),
        );

        expect(segments(parse).map((segment) => segment.payload)).toEqual([new Uint8Array(0), Uint8Array.of(1, 2)]);
    });

    it('decodes IPv6 addresses in their compressed form', () => {
        const client: Endpoint = { address: 'fd00::5', port: 40000 };
        const server: Endpoint = { address: '2001:db8:0:1:0:0:0:b', port: 443 };
        const parse = parsePcap(buildPcap([{ ...DATA_PACKET, source: client, destination: server }]));

        expect(segments(parse)[0]).toMatchObject({
            source: client,
            destination: { address: '2001:db8:0:1::b', port: 443 },
            payload: PAYLOAD,
        });
        expect(formatEndpoint(client)).toBe('[fd00::5]:40000');
    });

    it('counts packets cut inside their headers and keeps the captured part of a cut payload', () => {
        const parse = parsePcap(
            buildPcap([
                { ...DATA_PACKET, capturedBytes: 14 + 20 + 10 },
                { ...DATA_PACKET, capturedBytes: 14 + 20 + 20 + 4 },
                DATA_PACKET,
            ]),
        );

        expect(parse).toMatchObject({ kind: 'ok', truncatedPackets: 2, malformedPackets: 0 });
        expect(segments(parse).map((segment) => segment.payload)).toEqual([PAYLOAD.subarray(0, 4), PAYLOAD]);
    });

    it('counts a record cut off by the end of the file', () => {
        const file = buildPcap([DATA_PACKET, DATA_PACKET]);

        expect(parsePcap(file.subarray(0, -5))).toMatchObject({ kind: 'ok', truncatedPackets: 1 });
        expect(segments(parsePcap(file.subarray(0, -5)))).toHaveLength(1);
    });

    it('ignores non-first fragments and non-IP frames', () => {
        const file = buildPcap([{ ...DATA_PACKET, fragmentOffset: 0x0010 }, DATA_PACKET]);
        const arp = buildPcap([DATA_PACKET]);
        arp[24 + 16 + 12] = 0x08;
        arp[24 + 16 + 13] = 0x06;

        expect(segments(parsePcap(file))).toHaveLength(1);
        expect(parsePcap(arp)).toMatchObject({ kind: 'ok', segments: [], truncatedPackets: 0, malformedPackets: 0 });
    });

    it('counts a packet with an impossible header length as malformed', () => {
        const file = buildPcap([DATA_PACKET]);
        file[24 + 16 + 14] = 0x44;

        expect(parsePcap(file)).toMatchObject({ kind: 'ok', segments: [], malformedPackets: 1 });
    });

    it.each([
        ['pcapng', Uint8Array.of(0x0a, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0), 'pcapng'],
        ['an unknown magic number', new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n'.repeat(2)), 'not-pcap'],
        ['a tiny file', Uint8Array.of(0xd4, 0xc3), 'not-pcap'],
        ['a cut file header', buildPcap([]).subarray(0, 20), 'truncated-file-header'],
    ])('rejects %s', (_, bytes, reason) => {
        expect(parsePcap(bytes)).toEqual({ kind: 'unsupported', reason });
    });

    it('rejects an unsupported link type', () => {
        const file = buildPcap([DATA_PACKET]);
        file[20] = 105;

        expect(parsePcap(file)).toEqual({ kind: 'unsupported', reason: 'link-type' });
    });

    it('reads the input through its byte offset', () => {
        const file = buildPcap([DATA_PACKET]);

        expect(segments(parsePcap(concat([Uint8Array.of(9, 9, 9), file]).subarray(3)))[0]?.payload).toEqual(PAYLOAD);
    });
});
