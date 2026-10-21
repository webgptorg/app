import { describe, expect, it } from 'vitest';

import type { Endpoint, TcpFlags, TcpSegment } from './pcap.ts';
import { reassembleTcpStreams } from './tcp-streams.ts';

const CLIENT: Endpoint = { address: '10.0.0.5', port: 51234 };
const SERVER: Endpoint = { address: '10.0.0.11', port: 443 };

function segment(source: Endpoint, seq: number, payload = '', flags: Partial<TcpFlags> = { ack: true }): TcpSegment {
    return {
        timestampUs: 0,
        source,
        destination: source === CLIENT ? SERVER : CLIENT,
        seq: seq >>> 0,
        flags: { syn: false, ack: false, fin: false, rst: false, ...flags },
        payload: new TextEncoder().encode(payload),
    };
}

function handshake(clientIsn: number, serverIsn: number): TcpSegment[] {
    return [
        segment(CLIENT, clientIsn, '', { syn: true }),
        segment(SERVER, serverIsn, '', { syn: true, ack: true }),
        segment(CLIENT, clientIsn + 1),
    ];
}

function text(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

describe('reassembleTcpStreams', () => {
    it('reassembles both directions of an in-order connection', () => {
        const [connection, ...rest] = reassembleTcpStreams([
            ...handshake(100, 900),
            segment(CLIENT, 101, 'hello '),
            segment(CLIENT, 107, 'world'),
            segment(SERVER, 901, 'hi'),
            segment(CLIENT, 112, '', { fin: true, ack: true }),
        ]);

        expect(rest).toEqual([]);
        expect(connection).toMatchObject({ client: CLIENT, server: SERVER, sawHandshake: true, closed: true });
        expect(text(connection?.clientToServer.bytes ?? new Uint8Array())).toBe('hello world');
        expect(connection?.clientToServer).toMatchObject({ complete: true, missingBytes: 0, segments: 2 });
        expect(text(connection?.serverToClient.bytes ?? new Uint8Array())).toBe('hi');
    });

    it('identifies the client by the SYN even when the server sent the first captured segment', () => {
        const [connection] = reassembleTcpStreams([segment(SERVER, 900, '', { syn: true, ack: true })]);

        expect(connection).toMatchObject({ client: CLIENT, server: SERVER, sawHandshake: false });
    });

    it('orders out-of-order segments', () => {
        const [connection] = reassembleTcpStreams([
            ...handshake(100, 900),
            segment(CLIENT, 111, 'c'),
            segment(CLIENT, 101, 'a'.repeat(5)),
            segment(CLIENT, 106, 'b'.repeat(5)),
        ]);

        expect(text(connection?.clientToServer.bytes ?? new Uint8Array())).toBe('aaaaabbbbbc');
        expect(connection?.clientToServer.complete).toBe(true);
    });

    it('keeps the first copy of retransmitted and overlapping bytes', () => {
        const [connection] = reassembleTcpStreams([
            ...handshake(100, 900),
            segment(CLIENT, 101, 'abcdef'),
            segment(CLIENT, 101, 'abcdef'),
            segment(CLIENT, 104, 'XXXghij'),
            segment(CLIENT, 99, 'YYYYYY'),
            segment(CLIENT, 110, 'Zk'),
        ]);

        expect(text(connection?.clientToServer.bytes ?? new Uint8Array())).toBe('abcdefghijk');
        expect(connection?.clientToServer).toMatchObject({ complete: true, segments: 5 });
    });

    it('lets an earlier-captured segment win over a later one starting before it', () => {
        const [connection] = reassembleTcpStreams([
            ...handshake(100, 900),
            segment(CLIENT, 104, 'defg'),
            segment(CLIENT, 101, 'abcXXXXh'),
        ]);

        expect(text(connection?.clientToServer.bytes ?? new Uint8Array())).toBe('abcdefgh');
    });

    it('follows the sequence space across 2^32', () => {
        const isn = 2 ** 32 - 4;
        const [connection] = reassembleTcpStreams([
            ...handshake(isn, 900),
            segment(CLIENT, isn + 6, 'world'),
            segment(CLIENT, isn + 1, 'hello'),
        ]);

        expect(text(connection?.clientToServer.bytes ?? new Uint8Array())).toBe('helloworld');
        expect(connection?.clientToServer.complete).toBe(true);
    });

    it('stops at a gap and reports it', () => {
        const [connection] = reassembleTcpStreams([
            ...handshake(100, 900),
            segment(CLIENT, 101, 'abc'),
            segment(CLIENT, 110, 'xyz'),
        ]);

        expect(text(connection?.clientToServer.bytes ?? new Uint8Array())).toBe('abc');
        expect(connection?.clientToServer).toMatchObject({ complete: false, missingBytes: 6, segments: 2 });
    });

    it('reports a missing first segment as a gap at offset 0', () => {
        const [connection] = reassembleTcpStreams([...handshake(100, 900), segment(CLIENT, 105, 'late')]);

        expect(connection?.clientToServer).toMatchObject({ complete: false, missingBytes: 4 });
        expect(connection?.clientToServer.bytes.byteLength).toBe(0);
    });

    it('starts a new connection when a SYN reuses a closed 4-tuple', () => {
        const connections = reassembleTcpStreams([
            ...handshake(100, 900),
            segment(CLIENT, 101, 'first'),
            segment(CLIENT, 106, '', { fin: true, ack: true }),
            segment(SERVER, 901, '', { fin: true, ack: true }),
            ...handshake(7_000, 8_000),
            segment(CLIENT, 7_001, 'second'),
        ]);

        expect(connections.map((connection) => text(connection.clientToServer.bytes))).toEqual(['first', 'second']);
        expect(connections.map((connection) => connection.closed)).toEqual([true, false]);
    });

    it('keeps a SYN on an open 4-tuple in the same connection', () => {
        const connections = reassembleTcpStreams([
            ...handshake(100, 900),
            segment(CLIENT, 100, '', { syn: true }),
            segment(CLIENT, 101, 'abc'),
        ]);

        expect(connections).toHaveLength(1);
    });

    it('treats the endpoint with the lower port as the server when no SYN was captured', () => {
        const [connection] = reassembleTcpStreams([
            segment(SERVER, 5_000, 'from server'),
            segment(CLIENT, 3_000, 'abc'),
            segment(CLIENT, 2_997, 'xyz'),
        ]);

        expect(connection).toMatchObject({ client: CLIENT, server: SERVER, sawHandshake: false, closed: false });
        expect(text(connection?.clientToServer.bytes ?? new Uint8Array())).toBe('xyzabc');
        expect(text(connection?.serverToClient.bytes ?? new Uint8Array())).toBe('from server');
    });

    it('returns empty, complete streams for a connection without payload', () => {
        const [connection] = reassembleTcpStreams(handshake(100, 900));

        expect(connection?.serverToClient).toEqual({
            bytes: new Uint8Array(0),
            complete: true,
            missingBytes: 0,
            segments: 0,
        });
    });

    it('separates connections from different client ports', () => {
        const other: Endpoint = { address: CLIENT.address, port: 51235 };
        const connections = reassembleTcpStreams([
            segment(CLIENT, 100, '', { syn: true }),
            { ...segment(CLIENT, 200, '', { syn: true }), source: other },
        ]);

        expect(connections.map((connection) => connection.client.port)).toEqual([51234, 51235]);
    });
});
