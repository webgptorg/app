import type { IncomingMessage, ServerResponse } from 'node:http';
import * as https from 'node:https';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import * as tls from 'node:tls';

import type { Bytes, RelayId } from '@ptbk/protocol';
import { TUNNEL_PATH, TUNNEL_SUBPROTOCOL } from '@ptbk/protocol';
import type { RawData, WebSocket } from 'ws';
import { WebSocketServer } from 'ws';

import { listenLoopback } from '../harness/loopback';
import type { TestCa } from '../pki/test-ca';
import { createTestCa } from '../pki/test-ca';
import { EventQueue } from './event-queue';

/**
 * What the relay's own TLS listener presents for a relay hostname. Everything but `valid` must make the engine give up
 * before it sends a byte of WebSocket upgrade (tunnel-client.md, Dialling).
 */
export type CertificateMode = 'valid' | 'wrong-name' | 'untrusted-ca' | 'expired';

export type ConnectionEvent =
    | { readonly kind: 'text'; readonly text: string; readonly at: number }
    | { readonly kind: 'binary'; readonly bytes: Bytes; readonly at: number }
    | { readonly kind: 'closed'; readonly code: number; readonly at: number };

export interface ConnectionClosed {
    readonly code: number;
    readonly at: number;
}

/** Per relay hostname, since the relay started. */
export interface RelayCounters {
    /** ClientHellos naming the relay. */
    clientHellos: number;
    /** TLS handshakes the engine completed. */
    secured: number;
    /** WebSocket upgrades on `TUNNEL_PATH`. */
    upgrades: number;
    /** Requests on any other path, or without an upgrade. */
    strayRequests: number;
}

const MAX_MESSAGE_BYTES = 1 << 20;

function now(): number {
    return performance.now();
}

// `binaryType` stays 'nodebuffer', so ws hands over one Buffer per message, fragments already joined.
function toBytes(data: RawData): Bytes {
    return new Uint8Array(data as Buffer);
}

/** One engine WebSocket on the relay, before and after `ready`. */
export class RelayConnection {
    readonly relayId: RelayId;
    readonly openedAt = now();
    /** Subprotocols the engine offered in `Sec-WebSocket-Protocol`. */
    readonly offeredProtocols: readonly string[];
    /** `Sec-WebSocket-Extensions` as sent, or null. */
    readonly extensions: string | null;
    readonly events = new EventQueue<ConnectionEvent>();
    /** When each WebSocket ping arrived. */
    readonly pings: number[] = [];
    readonly closed: Promise<ConnectionClosed>;
    readonly #ws: WebSocket;
    #sink: ((event: ConnectionEvent) => void) | null = null;
    #closedAt: ConnectionClosed | null = null;

    constructor(ws: WebSocket, relayId: RelayId, request: IncomingMessage) {
        this.#ws = ws;
        this.relayId = relayId;
        this.offeredProtocols = (request.headers['sec-websocket-protocol'] ?? '')
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part !== '');
        this.extensions = request.headers['sec-websocket-extensions'] ?? null;
        ws.on('error', () => undefined);
        ws.on('ping', () => this.pings.push(now()));
        ws.on('message', (data, isBinary) => {
            const event: ConnectionEvent = isBinary
                ? { kind: 'binary', bytes: toBytes(data), at: now() }
                : { kind: 'text', text: (data as Buffer).toString('utf8'), at: now() };
            this.#deliver(event);
        });
        this.closed = new Promise((resolve) => {
            ws.once('close', (code) => {
                this.#closedAt = { code, at: now() };
                this.#deliver({ kind: 'closed', code, at: this.#closedAt.at });
                resolve(this.#closedAt);
            });
        });
    }

    #deliver(event: ConnectionEvent): void {
        if (this.#sink === null) this.events.push(event);
        else this.#sink(event);
    }

    /** Routes every later event to `sink` instead of `events`, after replaying what is queued. */
    takeOver(sink: (event: ConnectionEvent) => void): void {
        for (const event of this.events.drain()) sink(event);
        this.#sink = sink;
    }

    isOpen(): boolean {
        return this.#closedAt === null;
    }

    sendText(text: string): void {
        if (this.isOpen()) this.#ws.send(text);
    }

    sendJson(message: unknown): void {
        this.sendText(JSON.stringify(message));
    }

    sendBinary(bytes: Uint8Array): void {
        if (this.isOpen()) this.#ws.send(bytes, { binary: true });
    }

    close(code: number): void {
        if (this.isOpen()) this.#ws.close(code);
    }

    /** Drops the TCP connection without a close frame, like a crashed relay. */
    terminate(): void {
        this.#ws.terminate();
    }
}

export interface FakeRelayOptions {
    readonly relayIds: readonly RelayId[];
    /** The CA the engine trusts for relay certificates (the harness's). */
    readonly trustedCa: TestCa;
}

export interface FakeRelay {
    /** An address it listens on (also on ::1 where the host has IPv6); relay hostnames resolve to loopback. */
    readonly host: string;
    readonly port: number;
    readonly relayIds: readonly RelayId[];
    /** `wss://<relayId>:<port>/v1/tunnel`. */
    url(relayId: RelayId): string;
    setCertificate(relayId: RelayId, mode: CertificateMode): void;
    /** `false` drops every new TCP connection at once, like a relay that is down. */
    setAccepting(accepting: boolean): void;
    /** Every WebSocket the engine opens goes to `handler`; there is one handler for the whole relay. */
    onConnection(handler: (connection: RelayConnection) => void): void;
    counters(relayId: RelayId): Readonly<RelayCounters>;
    /** Terminates every live connection without a close frame. */
    terminateAll(): void;
    close(): Promise<void>;
}

/**
 * The relay's network side: one TLS listener serving every relay hostname by SNI with a certificate from the harness
 * CA (or a deliberately bad one), and WebSockets on `TUNNEL_PATH`. What happens on a WebSocket is the handler's job.
 */
export async function startFakeRelay(options: FakeRelayOptions): Promise<FakeRelay> {
    const relayIds = new Set<string>(options.relayIds);
    const untrustedCa = createTestCa('ptbk-conformance-untrusted');
    const contexts = new Map<string, tls.SecureContext>();
    const counters = new Map<string, RelayCounters>(
        options.relayIds.map((id) => [id, { clientHellos: 0, secured: 0, upgrades: 0, strayRequests: 0 }]),
    );
    const sockets = new Set<Socket>();
    const connections = new Set<RelayConnection>();
    let accepting = true;
    let handler: (connection: RelayConnection) => void = (connection) => {
        connection.close(1011);
    };

    function contextFor(relayId: RelayId, mode: CertificateMode): tls.SecureContext {
        const certificate =
            mode === 'valid'
                ? options.trustedCa.issue([relayId])
                : mode === 'wrong-name'
                  ? options.trustedCa.issue([`not-${relayId}`])
                  : mode === 'untrusted-ca'
                    ? untrustedCa.issue([relayId])
                    : options.trustedCa.issue([relayId], {
                          notBefore: new Date(Date.now() - 48 * 3_600_000),
                          notAfter: new Date(Date.now() - 24 * 3_600_000),
                      });
        return tls.createSecureContext({ cert: certificate.certPem, key: certificate.keyPem });
    }

    function counterOf(relayId: string): RelayCounters {
        const counter = counters.get(relayId);
        if (counter === undefined) throw new RangeError('unknown relay');
        return counter;
    }

    for (const relayId of options.relayIds) contexts.set(relayId, contextFor(relayId, 'valid'));

    const wss = new WebSocketServer({
        noServer: true,
        maxPayload: MAX_MESSAGE_BYTES,
        perMessageDeflate: false,
        handleProtocols: (protocols) => (protocols.has(TUNNEL_SUBPROTOCOL) ? TUNNEL_SUBPROTOCOL : false),
    });

    // One server per loopback address family: an engine may resolve a `*.localhost` relay to either.
    const makeServer = (): https.Server => {
        const server = https.createServer({
            // TLS 1.2 is the relay's own minimum (ADR 0014); the engine may negotiate 1.3.
            minVersion: 'TLSv1.2',
            SNICallback(servername, callback) {
                const relayId = servername.toLowerCase();
                const context = contexts.get(relayId);
                if (context === undefined) {
                    callback(new Error('unknown relay hostname'));
                    return;
                }
                counterOf(relayId).clientHellos++;
                callback(null, context);
            },
        });
        server.on('connection', (socket: Socket) => {
            if (!accepting) {
                socket.destroy();
                return;
            }
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
        });
        server.on('secureConnection', (socket: tls.TLSSocket) => {
            const name = servernameOf(socket);
            if (relayIds.has(name)) counterOf(name).secured++;
        });
        server.on('tlsClientError', () => undefined);
        server.on('request', (request: IncomingMessage, response: ServerResponse) => {
            const name = servernameOf(request.socket);
            if (relayIds.has(name)) counterOf(name).strayRequests++;
            response.writeHead(404).end();
        });
        server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
            const name = servernameOf(request.socket);
            const path = new URL(request.url ?? '/', 'https://relay.invalid').pathname;
            if (!relayIds.has(name) || path !== TUNNEL_PATH) {
                if (relayIds.has(name)) counterOf(name).strayRequests++;
                socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
                return;
            }
            counterOf(name).upgrades++;
            wss.handleUpgrade(request, socket, head, (ws) => {
                const connection = new RelayConnection(ws, name as RelayId, request);
                connections.add(connection);
                void connection.closed.then(() => connections.delete(connection));
                handler(connection);
            });
        });
        return server;
    };
    const listener = await listenLoopback(makeServer);
    const { port } = listener;

    return {
        host: '127.0.0.1',
        port,
        relayIds: options.relayIds,
        url: (relayId) => `wss://${relayId}:${String(port)}${TUNNEL_PATH}`,
        setCertificate(relayId, mode) {
            contexts.set(relayId, contextFor(relayId, mode));
        },
        setAccepting(next) {
            accepting = next;
        },
        onConnection(next) {
            handler = next;
        },
        counters: (relayId) => ({ ...counterOf(relayId) }),
        terminateAll() {
            for (const connection of connections) connection.terminate();
        },
        async close() {
            for (const connection of connections) connection.terminate();
            for (const socket of sockets) socket.destroy();
            wss.close();
            await listener.close();
        },
    };
}

function servernameOf(socket: unknown): string {
    const name = (socket as Partial<tls.TLSSocket>).servername;
    return typeof name === 'string' ? name.toLowerCase() : '';
}
