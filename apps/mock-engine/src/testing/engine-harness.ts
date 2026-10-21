import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { duplexPair } from 'node:stream';
import type { TLSSocket } from 'node:tls';
import { checkServerIdentity as checkIdentity, connect } from 'node:tls';

import type { EngineId } from '@ptbk/protocol';
import { Hostname as HostnameSchema } from '@ptbk/protocol';
import { WebSocket } from 'ws';

import type { DevCa } from '../adapters/dev-ca';
import { createDevCa, createDevCaCertificateSource } from '../adapters/dev-ca';
import type { Faults } from '../adapters/http/fault-middleware';
import type { HttpApp } from '../adapters/http/http-app';
import { createHttpApp } from '../adapters/http/http-app';
import type { Route } from '../adapters/http/route';
import type { SpikeRouteDeps } from '../adapters/http/spike-routes';
import { createSpikeRoutes } from '../adapters/http/spike-routes';
import type { TlsStreamServer } from '../adapters/tls-stream-server';
import { createTlsStreamServer } from '../adapters/tls-stream-server';
import type { Clock } from '../domain/clock';
import type { RateLimiter } from '../domain/rate-limit/rate-limiter';
import { createWindowRateLimiter } from '../domain/rate-limit/rate-limiter';
import type { SessionStore } from '../domain/gateway/sessions';
import type { ManagedCertificateSource } from '../domain/tls/certificate-source';
import type { MemoryLogger } from './memory-logger';
import { createMemoryLogger } from './memory-logger';

export const HARNESS_ENGINE_ID = 'abcdefghijklmnopqrstuvwxyz' as EngineId;
export const HARNESS_CANARY = '0123456789abcdef0123456789abcdef';
export const HARNESS_DOMAIN = HostnameSchema.parse('engine.test');
export const HARNESS_HOSTNAME = HostnameSchema.parse(`${HARNESS_ENGINE_ID}.engine.test`);
export const HARNESS_CLIENT_IP = '198.51.100.23';

export interface HarnessOptions {
    readonly clock?: Clock;
    readonly rateLimiter?: RateLimiter;
    readonly onDownloadBytes?: SpikeRouteDeps['onDownloadBytes'];
    /** Replaces the spike routes, to test the HTTP app with routes of the test's own. */
    readonly routes?: readonly Route[];
    readonly sessions?: SessionStore;
    readonly faults?: Faults;
}

export interface ConnectOptions {
    /** SNI; defaults to the engine hostname. `null` sends none. */
    readonly servername?: string | null;
    /** The address the fake `OPEN` frame carries. */
    readonly clientIp?: string;
    /** Trusted roots; defaults to the harness dev CA. */
    readonly ca?: string;
    readonly ALPNProtocols?: string[];
}

export interface HarnessResponse {
    readonly status: number;
    readonly headers: IncomingHttpHeaders;
    readonly body: Buffer;
}

export interface EngineHarness {
    readonly ca: DevCa;
    readonly certificates: ManagedCertificateSource;
    readonly tls: TlsStreamServer;
    readonly http: HttpApp;
    readonly logger: MemoryLogger;
    /** A TLS client over a fresh pair of linked duplexes standing in for one tunnel stream. */
    connect(options?: ConnectOptions): Promise<TLSSocket>;
    /** The same, before the handshake completes (for HTTP clients that take a `createConnection`). */
    openSocket(options?: ConnectOptions): TLSSocket;
    /** One GET over its own connection; resolves once the whole body arrived. */
    get(
        path: string,
        options?: ConnectOptions & { readonly headers?: Record<string, string> },
    ): Promise<HarnessResponse>;
    /** One GET over its own connection; resolves with the response as soon as its headers arrived (streaming). */
    stream(
        path: string,
        options?: ConnectOptions & { readonly headers?: Record<string, string> },
    ): Promise<IncomingMessage>;
    /**
     * A WebSocket over its own connection; resolves once open. `onSocket` sees it before it opens, for listeners that
     * must not miss a message arriving with the upgrade response.
     */
    webSocket(
        path: string,
        options?: ConnectOptions & { readonly onSocket?: (socket: WebSocket) => void },
    ): Promise<WebSocket>;
    close(): void;
}

/**
 * The engine's TLS server and HTTP app without a relay: each connection is a `duplexPair`, the server end handed to
 * the TLS server with a client IP as the tunnel's `OPEN` frame would carry it. Uses real time unless given a clock.
 */
export function createEngineHarness(options: HarnessOptions = {}): EngineHarness {
    const clock: Clock = options.clock ?? {
        nowMs: () => Date.now(),
        setTimeout(fn, ms) {
            const timer = setTimeout(fn, ms);
            return () => {
                clearTimeout(timer);
            };
        },
    };
    const logger = createMemoryLogger();
    const ca = createDevCa([HARNESS_DOMAIN], clock);
    const certificates = createDevCaCertificateSource({ ca, clock, logger });
    certificates.addHostnames([HARNESS_HOSTNAME]);
    const http = createHttpApp({
        routes:
            options.routes ??
            createSpikeRoutes({
                engineId: HARNESS_ENGINE_ID,
                clock,
                canary: HARNESS_CANARY,
                ...(options.onDownloadBytes === undefined ? {} : { onDownloadBytes: options.onDownloadBytes }),
            }),
        rateLimiter: options.rateLimiter ?? createWindowRateLimiter({ clock }),
        logger,
        ...(options.sessions === undefined ? {} : { sessions: options.sessions }),
        ...(options.faults === undefined ? {} : { faults: options.faults }),
    });
    const tls = createTlsStreamServer({
        certificates,
        logger,
        onSecureConnection: (socket, connection) => {
            http.serve(socket, connection);
        },
    });
    const clients = new Set<TLSSocket>();

    function open(connectOptions: ConnectOptions = {}): TLSSocket {
        const [client, server] = duplexPair();
        // A tunnel stream's CLOSE is a full close in both directions (C-02 has no half-close); a bare pair would
        // only end the other side's readable half.
        client.once('close', () => server.destroy());
        server.once('close', () => client.destroy());
        tls.handle(server, { family: 'IPv4', address: connectOptions.clientIp ?? HARNESS_CLIENT_IP, port: 50_000 });
        const servername = connectOptions.servername === undefined ? HARNESS_HOSTNAME : connectOptions.servername;
        const socket = connect({
            socket: client,
            ca: connectOptions.ca ?? ca.certificatePem,
            ALPNProtocols: connectOptions.ALPNProtocols ?? ['http/1.1'],
            ...(servername === null ? {} : { servername }),
            // Verify against the SNI name, as a browser verifies against the URL's host.
            checkServerIdentity: (_host, certificate) =>
                servername === null ? undefined : checkIdentity(servername, certificate),
        });
        clients.add(socket);
        socket.once('close', () => clients.delete(socket));
        return socket;
    }

    return {
        ca,
        certificates,
        tls,
        http,
        logger,
        openSocket: open,
        connect(connectOptions) {
            const socket = open(connectOptions);
            return new Promise((resolve, reject) => {
                socket.once('secureConnect', () => {
                    resolve(socket);
                });
                socket.once('error', reject);
            });
        },
        get(path, requestOptions = {}) {
            return new Promise((resolve, reject) => {
                const request = httpRequest(
                    {
                        path,
                        host: requestOptions.servername ?? HARNESS_HOSTNAME,
                        headers: requestOptions.headers,
                        createConnection: () => open(requestOptions),
                    },
                    (response) => {
                        const chunks: Buffer[] = [];
                        response.on('data', (chunk: Buffer) => chunks.push(chunk));
                        response.once('end', () => {
                            resolve({
                                status: response.statusCode ?? 0,
                                headers: response.headers,
                                body: Buffer.concat(chunks),
                            });
                            response.socket.destroy();
                        });
                        response.once('error', reject);
                    },
                );
                request.once('error', reject);
                request.end();
            });
        },
        stream(path, requestOptions = {}) {
            return new Promise((resolve, reject) => {
                const request = httpRequest(
                    {
                        path,
                        host: requestOptions.servername ?? HARNESS_HOSTNAME,
                        headers: requestOptions.headers,
                        createConnection: () => open(requestOptions),
                    },
                    resolve,
                );
                request.once('error', reject);
                request.end();
            });
        },
        webSocket(path, connectOptions = {}) {
            const ws = new WebSocket(`wss://${HARNESS_HOSTNAME}${path}`, {
                createConnection: () => open(connectOptions),
                perMessageDeflate: false,
                maxPayload: 64 * 1024 * 1024,
            });
            connectOptions.onSocket?.(ws);
            return new Promise((resolve, reject) => {
                ws.once('open', () => {
                    resolve(ws);
                });
                ws.once('error', reject);
                ws.once('unexpected-response', (_request, response) => {
                    reject(new Error(`unexpected response ${String(response.statusCode)}`));
                });
            });
        },
        close() {
            for (const socket of [...clients]) socket.destroy();
            tls.close();
            http.close();
            certificates.close();
        },
    };
}
