import { parseClientHello } from '@ptbk/protocol';
import type { ClientHelloParse } from '@ptbk/protocol';

import type { Endpoint } from './pcap.ts';
import { formatEndpoint, parsePcap } from './pcap.ts';
import type { PlaintextHaystack, PlaintextHit } from './plaintext.ts';
import { findPlaintext } from './plaintext.ts';
import type { DirectionalStream, TcpConnection } from './tcp-streams.ts';
import { reassembleTcpStreams } from './tcp-streams.ts';
import type { TlsStreamCheck } from './tls-records.ts';
import { checkTlsStream } from './tls-records.ts';

export interface CaptureAnalysisOptions {
    readonly serverPort: number;
    /** Compared case-insensitively with each connection's SNI. */
    readonly engineHostname: string;
    readonly forbiddenPlaintext: readonly string[];
}

export interface StreamSummary {
    readonly bytes: number;
    readonly segments: number;
    readonly complete: boolean;
}

interface ConnectionBase {
    /** `client -> server`, suffixed with `#n` when the same 4-tuple carried several connections. */
    readonly label: string;
    readonly client: Endpoint;
    readonly server: Endpoint;
    readonly sawHandshake: boolean;
    readonly closed: boolean;
    readonly clientToServer: StreamSummary;
    readonly serverToClient: StreamSummary;
}

export interface EngineConnection extends ConnectionBase {
    readonly kind: 'engine';
    /** The protocols the client offered: an ACME validation offers exactly `acme-tls/1`, a browser never does. */
    readonly alpn: readonly string[];
    readonly clientToServerTls: TlsStreamCheck;
    readonly serverToClientTls: TlsStreamCheck;
}

export interface OtherTlsConnection extends ConnectionBase {
    readonly kind: 'other-tls';
    readonly hostname: string;
}

export interface NonTlsConnection extends ConnectionBase {
    readonly kind: 'not-tls';
    /** Why the start of the client's stream gave no SNI. */
    readonly clientHello: Exclude<ClientHelloParse['kind'], 'sni'>;
}

export type ConnectionSummary = EngineConnection | OtherTlsConnection | NonTlsConnection;

export interface CaptureAnalysis {
    readonly engineConnections: number;
    /** Connections to `serverPort`, in order of first appearance. */
    readonly connections: readonly ConnectionSummary[];
    /** Human-readable, holding endpoints, offsets and counts but never captured bytes. */
    readonly problems: readonly string[];
    readonly plaintextHits: readonly PlaintextHit[];
}

const CLIENT_HELLO_LIMITS = { maxBytes: 16_384 } as const;

/**
 * Checks a capture of a relay's TLS port: every connection whose SNI is the engine's must be TLS records end to end
 * in both directions, and no forbidden string may appear in plaintext in any packet or reassembled stream.
 */
export function analyseCapture(pcapBytes: Uint8Array, options: CaptureAnalysisOptions): CaptureAnalysis {
    const parsed = parsePcap(pcapBytes);
    if (parsed.kind === 'unsupported') {
        return {
            engineConnections: 0,
            connections: [],
            problems: [`capture is not a supported pcap file (${parsed.reason})`],
            plaintextHits: [],
        };
    }
    const problems: string[] = [];
    if (parsed.malformedPackets > 0) {
        problems.push(`packets with malformed IP or TCP headers went unchecked: ${String(parsed.malformedPackets)}`);
    }

    const tcpConnections = reassembleTcpStreams(parsed.segments);
    const suffixes = repeatSuffixes(tcpConnections);
    const haystacks: PlaintextHaystack[] = parsed.segments.map((segment, index) => ({
        label: `segment ${String(index)} ${formatEndpoint(segment.source)} -> ${formatEndpoint(segment.destination)}`,
        bytes: segment.payload,
    }));
    const connections: ConnectionSummary[] = [];
    tcpConnections.forEach((connection, index) => {
        const client = formatEndpoint(connection.client);
        const server = formatEndpoint(connection.server);
        const suffix = suffixes[index] ?? '';
        const label = `${client} -> ${server}${suffix}`;
        haystacks.push(
            { label, bytes: connection.clientToServer.bytes },
            { label: `${server} -> ${client}${suffix}`, bytes: connection.serverToClient.bytes },
        );
        if (connection.server.port !== options.serverPort) return;
        const summary = summarise(connection, label, options.engineHostname);
        if (summary.kind === 'engine') problems.push(...engineProblems(summary, connection));
        connections.push(summary);
    });

    return {
        engineConnections: connections.filter((connection) => connection.kind === 'engine').length,
        connections,
        problems,
        plaintextHits: findPlaintext(haystacks, options.forbiddenPlaintext),
    };
}

function summarise(connection: TcpConnection, label: string, engineHostname: string): ConnectionSummary {
    const base: ConnectionBase = {
        label,
        client: connection.client,
        server: connection.server,
        sawHandshake: connection.sawHandshake,
        closed: connection.closed,
        clientToServer: streamSummary(connection.clientToServer),
        serverToClient: streamSummary(connection.serverToClient),
    };
    const hello = parseClientHello(connection.clientToServer.bytes, CLIENT_HELLO_LIMITS);
    if (hello.kind !== 'sni') return { ...base, kind: 'not-tls', clientHello: hello.kind };
    if (hello.hostname.toLowerCase() !== engineHostname.toLowerCase()) {
        return { ...base, kind: 'other-tls', hostname: hello.hostname };
    }
    const tlsOptions = { allowTruncatedTail: true };
    return {
        ...base,
        kind: 'engine',
        alpn: hello.alpn,
        clientToServerTls: checkTlsStream(connection.clientToServer.bytes, tlsOptions),
        serverToClientTls: checkTlsStream(connection.serverToClient.bytes, tlsOptions),
    };
}

function engineProblems(summary: EngineConnection, connection: TcpConnection): string[] {
    return [
        ...directionProblems(
            `${summary.label} (client to server)`,
            connection.clientToServer,
            summary.clientToServerTls,
        ),
        ...directionProblems(
            `${summary.label} (server to client)`,
            connection.serverToClient,
            summary.serverToClientTls,
        ),
    ];
}

function directionProblems(label: string, stream: DirectionalStream, tls: TlsStreamCheck): string[] {
    const problems: string[] = [];
    if (!stream.complete) {
        const at = String(stream.bytes.byteLength);
        problems.push(`${label}: ${String(stream.missingBytes)} bytes missing from the capture at offset ${at}`);
    }
    if (tls.kind === 'invalid') problems.push(`${label}: ${tls.problem.description}`);
    return problems;
}

function streamSummary(stream: DirectionalStream): StreamSummary {
    return { bytes: stream.bytes.byteLength, segments: stream.segments, complete: stream.complete };
}

function repeatSuffixes(connections: readonly TcpConnection[]): string[] {
    const seen = new Map<string, number>();
    return connections.map((connection) => {
        const tuple = `${formatEndpoint(connection.client)} ${formatEndpoint(connection.server)}`;
        const occurrence = (seen.get(tuple) ?? 0) + 1;
        seen.set(tuple, occurrence);
        return occurrence === 1 ? '' : ` #${String(occurrence)}`;
    });
}
