import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo, Server as NetServer, Socket } from 'node:net';
import { createServer as createNetServer, isIPv4 } from 'node:net';
import type { Duplex } from 'node:stream';
import type { SecureContext } from 'node:tls';
import { TLSSocket, createSecureContext } from 'node:tls';

import { FRAME_HEADER_BYTES, MAX_FRAME_PAYLOAD_BYTES, TUNNEL_PATH, TUNNEL_SUBPROTOCOL } from '@ptbk/protocol';
import { WebSocketServer } from 'ws';

import type { Clock } from '../domain/clock';
import type { PendingConnection, TunnelEndpoint } from '../domain/tunnel/tunnel-endpoint';
import type { WsLivenessOptions } from './ws-tunnel-transport';
import { attachWsTunnel } from './ws-tunnel-transport';

/**
 * ADR 0014: AEAD only. TLS 1.3 suites are all AEAD; TLS 1.2 is limited to ECDHE with AES-GCM or ChaCha20-Poly1305,
 * for ECDSA and RSA certificates alike. The minimum rises to TLS 1.3 once X-02 shows TLS-inspecting proxies cope.
 */
export const RELAY_TLS_CIPHERS = [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384',
    'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305',
    'ECDHE-RSA-CHACHA20-POLY1305',
].join(':');
export const RELAY_TLS_MIN_VERSION = 'TLSv1.2';

/** How long `close` waits for engines to acknowledge `SHUTTING_DOWN` before it destroys their sockets. */
export const CLOSE_GRACE_MS = 2_000;
/** Request heads are tiny here (an upgrade or a health check). */
const MAX_HEADER_BYTES = 8_192;

export interface OwnTlsServerOptions {
    /** The relay's own certificate chain and key (PEM); never an engine's. */
    readonly cert: string;
    readonly key: string;
    readonly endpoint: TunnelEndpoint;
    /** Real time in production; pings must not fire when a test moves the endpoint's fake clock. */
    readonly liveness: WsLivenessOptions;
    /** Times the shutdown grace period. */
    readonly clock: Clock;
}

export interface OwnTlsServer {
    /** A TCP connection for the relay's own hostname, from its listener or, later, R-04's SNI dispatcher. */
    acceptSocket(socket: Socket): void;
    /** Resolves with the bound port. */
    listen(port: number, host: string): Promise<number>;
    /** Stops accepting, closes every tunnel with `SHUTTING_DOWN`, and resolves once every socket is gone. */
    close(): Promise<void>;
}

export function createRelaySecureContext(cert: string, key: string): SecureContext {
    return createSecureContext({
        cert,
        key,
        minVersion: RELAY_TLS_MIN_VERSION,
        ciphers: RELAY_TLS_CIPHERS,
        honorCipherOrder: true,
    });
}

/** `::ffff:192.0.2.1` and `192.0.2.1` are one client, so they share one per-IP limit. */
export function clientIp(address: string | undefined): string | undefined {
    if (address?.startsWith('::ffff:') === true) {
        const mapped = address.slice('::ffff:'.length);
        if (isIPv4(mapped)) return mapped;
    }
    return address;
}

function refuseUpgrade(socket: Duplex, status: string): void {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
}

function offersSubprotocol(request: IncomingMessage): boolean {
    const header = request.headers['sec-websocket-protocol'];
    return header?.split(',').some((protocol) => protocol.trim() === TUNNEL_SUBPROTOCOL) === true;
}

/**
 * The only place the relay terminates TLS, and only for its own hostname: `GET /v1/tunnel` upgrades to the tunnel
 * WebSocket, `GET /healthz` answers `ok`, everything else is 404. The endpoint admits each socket at TCP accept, so
 * the handshake deadline and the pending-handshake limits cover the TLS handshake too.
 */
export function createOwnTlsServer(options: OwnTlsServerOptions): OwnTlsServer {
    const { endpoint, liveness, clock } = options;
    const secureContext = createRelaySecureContext(options.cert, options.key);
    const pendingBySocket = new WeakMap<Duplex, PendingConnection>();
    const sockets = new Set<Socket>();
    let netServer: NetServer | null = null;

    const wss = new WebSocketServer({
        noServer: true,
        clientTracking: false,
        perMessageDeflate: false,
        maxPayload: FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES,
        handleProtocols: (protocols) => (protocols.has(TUNNEL_SUBPROTOCOL) ? TUNNEL_SUBPROTOCOL : false),
    });

    const http = createHttpServer(
        { maxHeaderSize: MAX_HEADER_BYTES },
        (request: IncomingMessage, response: ServerResponse) => {
            if (request.method === 'GET' && request.url === '/healthz') {
                response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok');
            } else {
                response.writeHead(404).end();
            }
        },
    );
    http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const pending = pendingBySocket.get(socket);
        if (pending === undefined || request.method !== 'GET' || request.url !== TUNNEL_PATH) {
            refuseUpgrade(socket, '404 Not Found');
        } else if (!offersSubprotocol(request)) {
            refuseUpgrade(socket, '400 Bad Request');
        } else {
            wss.handleUpgrade(request, socket, head, (ws) => {
                attachWsTunnel(ws, pending, liveness);
            });
        }
    });
    http.on('clientError', (_error: Error, socket: Duplex) => {
        socket.destroy();
    });

    function acceptSocket(socket: Socket): void {
        socket.on('error', () => undefined);
        const ip = clientIp(socket.remoteAddress);
        const pending =
            ip === undefined
                ? null
                : endpoint.accept(ip, () => {
                      socket.destroy();
                  });
        if (pending === null) {
            socket.destroy();
            return;
        }
        sockets.add(socket);
        socket.once('close', () => {
            sockets.delete(socket);
            pending.socketClosed();
        });
        const tlsSocket = new TLSSocket(socket, { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] });
        // A failed TLS handshake (old version, no shared cipher) or a reset: nothing to answer.
        tlsSocket.on('error', () => {
            tlsSocket.destroy();
        });
        pendingBySocket.set(tlsSocket, pending);
        http.emit('connection', tlsSocket);
    }

    return {
        acceptSocket,
        listen(port, host) {
            const server = createNetServer({ noDelay: true }, acceptSocket);
            netServer = server;
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => {
                    server.off('error', reject);
                    resolve((server.address() as AddressInfo).port);
                });
            });
        },
        async close() {
            const listening = netServer;
            const stopped =
                listening === null
                    ? Promise.resolve()
                    : new Promise<void>((resolve) => {
                          listening.close(() => {
                              resolve();
                          });
                      });
            endpoint.shutdown();
            const cancelGrace = clock.setTimeout(() => {
                for (const socket of sockets) socket.destroy();
            }, CLOSE_GRACE_MS);
            await Promise.all([
                stopped,
                ...[...sockets].map((socket) => new Promise((resolve) => socket.once('close', resolve))),
            ]);
            cancelGrace();
        },
    };
}
