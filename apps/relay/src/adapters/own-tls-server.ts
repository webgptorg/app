import { constants as cryptoConstants } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo, Server as NetServer, Socket } from 'node:net';
import { createServer as createNetServer, isIPv4 } from 'node:net';
import type { Duplex } from 'node:stream';
import type { SecureContext } from 'node:tls';
import { TLSSocket, createSecureContext } from 'node:tls';

import { FRAME_HEADER_BYTES, MAX_FRAME_PAYLOAD_BYTES, TUNNEL_PATH, TUNNEL_SUBPROTOCOL } from '@ptbk/protocol';
import type { ServerOptions } from 'ws';
import { WebSocketServer } from 'ws';

import type { Clock } from '../domain/clock';
import type { Logger } from '../domain/logger';
import type { PendingConnection, TunnelEndpoint } from '../domain/tunnel/tunnel-endpoint';
import type { MetricsEndpoint } from './metrics-endpoint';
import type { WsTunnelOptions } from './ws-tunnel-transport';
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
/** How long `ws` waits for the engine's close frame before it destroys the socket (its default is 30 s). */
export const WS_CLOSE_TIMEOUT_MS = 2_000;
/**
 * Message fragments and buffered socket chunks `ws` holds for one message. A tunnel message is one frame of at most
 * `MAX_WS_MESSAGE_BYTES`; this allows it in pieces of 512 bytes or more, where `ws`'s defaults would let a peer pin
 * 16,384 fragment or 262,144 chunk objects per connection.
 */
export const MAX_WS_MESSAGE_PARTS = 128;
const MAX_WS_MESSAGE_BYTES = FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD_BYTES;
export const METRICS_PATH = '/metrics';
/** Request heads are tiny here (an upgrade, a health check or a metrics scrape). */
const MAX_HEADER_BYTES = 8_192;

export interface OwnTlsServerOptions {
    /** The relay's own certificate chain and key (PEM); never an engine's. */
    readonly cert: string;
    readonly key: string;
    readonly endpoint: TunnelEndpoint;
    /** How each upgraded WebSocket is run; its clock is real time in production. */
    readonly tunnel: WsTunnelOptions;
    /** Times the shutdown grace period. */
    readonly clock: Clock;
    readonly logger: Logger;
    /** Backstop for `listen`'s own server; in production the browser listener admits every socket. */
    readonly maxConnections: number;
    /** `null`: no metrics token is configured, and `/metrics` is 404 like any unknown path. */
    readonly metrics: MetricsEndpoint | null;
    /** Sent with `/healthz` as `ptbk-relay-image`, so the deploy pipeline sees which signed image runs (I-03). */
    readonly imageDigest?: string | null;
}

export interface OwnTlsServer {
    /**
     * A TCP connection for the relay's own hostname, from its listener or R-04's SNI dispatcher, which passes when it
     * accepted the connection (on the endpoint's clock) so the handshake deadline still counts from TCP accept.
     */
    acceptSocket(socket: Socket, acceptedAtMs?: number): void;
    /** Resolves with the bound port. */
    listen(port: number, host: string): Promise<number>;
    /** New connections use this certificate and key; open tunnels keep theirs. Throws if Node cannot load them. */
    setCertificate(cert: string, key: string): void;
    /** Stops accepting, closes every tunnel with `SHUTTING_DOWN`, and resolves once every socket is gone. */
    close(): Promise<void>;
}

/**
 * No session tickets: tunnels live for hours, so resumption saves nothing, and ticket keys made per context would
 * otherwise never rotate. With the option set, OpenSSL issues no tickets in TLS 1.2 and only stateful ones that Node
 * keeps no cache for in TLS 1.3, so no session can be resumed.
 */
export function createRelaySecureContext(cert: string, key: string): SecureContext {
    return createSecureContext({
        cert,
        key,
        minVersion: RELAY_TLS_MIN_VERSION,
        ciphers: RELAY_TLS_CIPHERS,
        honorCipherOrder: true,
        secureOptions: cryptoConstants.SSL_OP_NO_TICKET,
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

function serveMetrics(metrics: MetricsEndpoint, request: IncomingMessage, response: ServerResponse): void {
    if (!metrics.authorize(request.headers.authorization)) {
        response.writeHead(401, { 'www-authenticate': 'Bearer', 'cache-control': 'no-store' }).end();
        return;
    }
    response.writeHead(200, { 'content-type': metrics.contentType, 'cache-control': 'no-store' }).end(metrics.render());
}

/**
 * The only place the relay terminates TLS, and only for its own hostname: `GET /v1/tunnel` upgrades to the tunnel
 * WebSocket, `GET /healthz` answers `ok` (with the image digest in `ptbk-relay-image` when the host set one),
 * `GET /metrics` answers the metrics token (ADR 0008), everything else is 404. The endpoint admits each socket at TCP
 * accept, so the handshake deadline and the pending-handshake limits cover the TLS handshake too.
 */
export function createOwnTlsServer(options: OwnTlsServerOptions): OwnTlsServer {
    const { endpoint, tunnel, clock, logger } = options;
    const healthHeaders: Record<string, string> = { 'content-type': 'text/plain; charset=utf-8' };
    if (options.imageDigest != null) healthHeaders['ptbk-relay-image'] = options.imageDigest;
    let secureContext = createRelaySecureContext(options.cert, options.key);
    const pendingBySocket = new WeakMap<Duplex, PendingConnection>();
    const sockets = new Set<Socket>();
    let netServer: NetServer | null = null;

    // `closeTimeout` is read by ws 8 but missing from its type definitions.
    const wsOptions: ServerOptions & { readonly closeTimeout: number } = {
        noServer: true,
        clientTracking: false,
        perMessageDeflate: false,
        maxPayload: MAX_WS_MESSAGE_BYTES,
        maxFragments: MAX_WS_MESSAGE_PARTS,
        maxBufferedChunks: MAX_WS_MESSAGE_PARTS,
        // The relay answers pings itself (`attachWsTunnel`), so a peer that does not read cannot queue pongs forever.
        autoPong: false,
        closeTimeout: WS_CLOSE_TIMEOUT_MS,
        handleProtocols: (protocols) => (protocols.has(TUNNEL_SUBPROTOCOL) ? TUNNEL_SUBPROTOCOL : false),
    };
    const wss = new WebSocketServer(wsOptions);

    const http = createHttpServer(
        { maxHeaderSize: MAX_HEADER_BYTES },
        (request: IncomingMessage, response: ServerResponse) => {
            if (request.method === 'GET' && request.url === '/healthz') {
                response.writeHead(200, healthHeaders).end('ok');
            } else if (request.method === 'GET' && request.url === METRICS_PATH && options.metrics !== null) {
                serveMetrics(options.metrics, request, response);
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
                attachWsTunnel(ws, pending, tunnel);
            });
        }
    });
    http.on('clientError', (_error: Error, socket: Duplex) => {
        socket.destroy();
    });

    function acceptSocket(socket: Socket, acceptedAtMs?: number): void {
        socket.on('error', () => undefined);
        const ip = clientIp(socket.remoteAddress);
        const pending =
            ip === undefined
                ? null
                : endpoint.accept(
                      ip,
                      () => {
                          socket.destroy();
                      },
                      acceptedAtMs,
                  );
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
            const server = createNetServer({ noDelay: true }, (socket) => {
                acceptSocket(socket);
            });
            server.maxConnections = options.maxConnections;
            netServer = server;
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => {
                    server.off('error', reject);
                    // Accept errors (EMFILE) are emitted here; without a listener they would end the process.
                    server.on('error', (error: Error) => {
                        logger.error('relay.accept-failed', { problem: error.name });
                    });
                    resolve((server.address() as AddressInfo).port);
                });
            });
        },
        setCertificate(cert, key) {
            secureContext = createRelaySecureContext(cert, key);
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
