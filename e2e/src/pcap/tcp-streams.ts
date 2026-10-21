import type { Endpoint, TcpSegment } from './pcap.ts';

export interface DirectionalStream {
    /** The contiguous bytes from the start of the stream up to the first hole in the capture. */
    readonly bytes: Uint8Array;
    readonly complete: boolean;
    /** Length of the first hole; 0 when the stream is complete. */
    readonly missingBytes: number;
    /** Captured segments that carried payload in this direction, retransmissions included. */
    readonly segments: number;
}

export interface TcpConnection {
    readonly client: Endpoint;
    readonly server: Endpoint;
    /** Whether the client's SYN was captured. Without it the stream start, and the client, are inferred. */
    readonly sawHandshake: boolean;
    readonly clientToServer: DirectionalStream;
    readonly serverToClient: DirectionalStream;
    /** A FIN or RST was seen in either direction. */
    readonly closed: boolean;
}

interface Piece {
    readonly seq: number;
    readonly payload: Uint8Array;
}

interface DirectionBuilder {
    isn: number | undefined;
    readonly pieces: Piece[];
}

interface ConnectionBuilder {
    readonly first: Endpoint;
    readonly second: Endpoint;
    readonly fromFirst: DirectionBuilder;
    readonly fromSecond: DirectionBuilder;
    synFromFirst: boolean | undefined;
    synAckFromFirst: boolean | undefined;
    closed: boolean;
}

interface Interval {
    readonly start: number;
    readonly bytes: Uint8Array;
}

/** Splits segments into connections and reassembles both directions of each, in order of first appearance. */
export function reassembleTcpStreams(segments: readonly TcpSegment[]): readonly TcpConnection[] {
    const current = new Map<string, ConnectionBuilder>();
    const connections: ConnectionBuilder[] = [];
    for (const segment of segments) {
        const key = tupleKey(segment.source, segment.destination);
        let connection = current.get(key);
        const initialSyn = segment.flags.syn && !segment.flags.ack;
        if (connection === undefined || (initialSyn && connection.closed)) {
            connection = {
                first: segment.source,
                second: segment.destination,
                fromFirst: { isn: undefined, pieces: [] },
                fromSecond: { isn: undefined, pieces: [] },
                synFromFirst: undefined,
                synAckFromFirst: undefined,
                closed: false,
            };
            current.set(key, connection);
            connections.push(connection);
        }
        record(connection, segment);
    }
    return connections.map(finish);
}

function record(connection: ConnectionBuilder, segment: TcpSegment): void {
    const fromFirst = sameEndpoint(segment.source, connection.first);
    const direction = fromFirst ? connection.fromFirst : connection.fromSecond;
    const { syn, ack, fin, rst } = segment.flags;
    if (syn) {
        direction.isn ??= segment.seq;
        if (ack) connection.synAckFromFirst ??= fromFirst;
        else connection.synFromFirst ??= fromFirst;
    }
    if (fin || rst) connection.closed = true;
    if (segment.payload.byteLength > 0) {
        direction.pieces.push({ seq: syn ? (segment.seq + 1) >>> 0 : segment.seq, payload: segment.payload });
    }
}

function finish(connection: ConnectionBuilder): TcpConnection {
    const clientIsFirst =
        connection.synFromFirst ??
        (connection.synAckFromFirst === undefined ? undefined : !connection.synAckFromFirst) ??
        connection.first.port >= connection.second.port;
    const [client, server] = clientIsFirst
        ? [connection.first, connection.second]
        : [connection.second, connection.first];
    const [fromClient, fromServer] = clientIsFirst
        ? [connection.fromFirst, connection.fromSecond]
        : [connection.fromSecond, connection.fromFirst];
    return {
        client,
        server,
        sawHandshake: connection.synFromFirst !== undefined,
        clientToServer: reassemble(fromClient),
        serverToClient: reassemble(fromServer),
        closed: connection.closed,
    };
}

function reassemble(direction: DirectionBuilder): DirectionalStream {
    const { pieces } = direction;
    const base = direction.isn === undefined ? lowestSeq(pieces) : (direction.isn + 1) >>> 0;
    const filled: Interval[] = [];
    for (const piece of pieces) fillUncovered(filled, relativeSeq(piece.seq, base), piece.payload);

    const chunks: Uint8Array[] = [];
    let cursor = 0;
    let missingBytes = 0;
    for (const interval of filled) {
        if (interval.start > cursor) {
            missingBytes = interval.start - cursor;
            break;
        }
        chunks.push(interval.bytes);
        cursor += interval.bytes.byteLength;
    }
    return { bytes: concat(chunks, cursor), complete: missingBytes === 0, missingBytes, segments: pieces.length };
}

/** Sequence numbers wrap at 2^32, so offsets are differences taken as signed 32-bit values. */
function relativeSeq(seq: number, base: number): number {
    return (seq - base) | 0;
}

function lowestSeq(pieces: readonly Piece[]): number {
    const [reference] = pieces;
    if (reference === undefined) return 0;
    let lowest = 0;
    for (const piece of pieces) lowest = Math.min(lowest, relativeSeq(piece.seq, reference.seq));
    return (reference.seq + lowest) >>> 0;
}

/**
 * Adds the parts of `[start, start + bytes)` that no earlier piece covered, so the first captured copy of every byte
 * wins over retransmissions. `filled` stays sorted and disjoint; bytes before the stream start are dropped.
 */
function fillUncovered(filled: Interval[], start: number, bytes: Uint8Array): void {
    const end = start + bytes.byteLength;
    let position = Math.max(start, 0);
    const firstIndex = firstEndingAfter(filled, position);
    let index = firstIndex;
    const replacement: Interval[] = [];
    while (position < end) {
        const next = filled[index];
        if (next === undefined || next.start >= end) {
            replacement.push({ start: position, bytes: bytes.subarray(position - start) });
            break;
        }
        if (next.start > position) {
            replacement.push({ start: position, bytes: bytes.subarray(position - start, next.start - start) });
        }
        replacement.push(next);
        position = Math.max(position, next.start + next.bytes.byteLength);
        index++;
    }
    filled.splice(firstIndex, index - firstIndex, ...replacement);
}

function firstEndingAfter(filled: readonly Interval[], position: number): number {
    let low = 0;
    let high = filled.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        const interval = filled[middle];
        if (interval !== undefined && interval.start + interval.bytes.byteLength <= position) low = middle + 1;
        else high = middle;
    }
    return low;
}

function concat(chunks: readonly Uint8Array[], length: number): Uint8Array {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

function tupleKey(a: Endpoint, b: Endpoint): string {
    const [low, high] = [endpointKey(a), endpointKey(b)].sort();
    return `${low ?? ''}|${high ?? ''}`;
}

function endpointKey(endpoint: Endpoint): string {
    return `${endpoint.address}/${String(endpoint.port)}`;
}

function sameEndpoint(a: Endpoint, b: Endpoint): boolean {
    return a.address === b.address && a.port === b.port;
}
