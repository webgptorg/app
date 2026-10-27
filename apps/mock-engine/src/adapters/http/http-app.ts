import type { IncomingMessage } from 'node:http';
import { STATUS_CODES, createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import type { HttpBindings } from '@hono/node-server';
import { getRequestListener } from '@hono/node-server';
import { createProblem } from '@ptbk/engine-api';
import type { Actor } from '@ptbk/engine-api/in-memory';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';

import type { SessionStore } from '../../domain/gateway/sessions';
import { engineSecurityHeaders } from '../../domain/http/security-headers';
import type { Logger } from '../../domain/logger';
import type { RateLimiter } from '../../domain/rate-limit/rate-limiter';
import type { SecureConnection } from '../tls-stream-server';
import type { Faults } from './fault-middleware';
import { withFaults } from './fault-middleware';
import { authenticate, isSameOriginMutation, requestTarget } from './gateway-middleware';
import type { HttpRoute, Route, WebSocketRoute } from './route';
import type { Problem } from './route-handler';
import {
    admitQueryAndHeaders,
    bySpecificity,
    honoPath,
    problemResponse,
    rateLimited,
    runHttpRoute,
} from './route-handler';

/** An idle connection (including a paused download) is closed after this long. */
export const SOCKET_IDLE_TIMEOUT_MS = 120_000;
const MAX_HEADER_BYTES = 16 * 1024;

/** Unless a route chose its own caching (the UI's files do), nothing the engine sends is stored. */
const DEFAULT_CACHE_CONTROL = 'no-store';

/**
 * The engine's security headers on every response, whatever the route set: a handler, a UI bundle or an error can
 * never send a different CSP or drop one.
 */
export function applySecurityHeaders(headers: Headers): void {
    for (const [name, value] of Object.entries(engineSecurityHeaders())) headers.set(name, value);
    if (!headers.has('Cache-Control')) headers.set('Cache-Control', DEFAULT_CACHE_CONTROL);
}

export interface HttpAppDeps {
    readonly routes: readonly Route[];
    readonly rateLimiter: RateLimiter;
    readonly logger: Logger;
    /** Required as soon as one route has `session` auth. */
    readonly sessions?: SessionStore;
    /** Applied to every HTTP route the plan's `routes` filter matches. */
    readonly faults?: Faults;
}

export interface HttpApp {
    /** Serves HTTP/1.1, with WebSocket upgrades, on one established TLS connection. */
    serve(socket: Socket, connection: SecureConnection): void;
    readonly routes: readonly Route[];
    /** Connections still open, upgraded ones included. */
    connections(): number;
    /** Destroys every connection. */
    close(): void;
}

function rejectUpgrade(socket: Duplex, result: Problem): void {
    const body = JSON.stringify(createProblem(result.code, result.extras));
    const status = createProblem(result.code).status;
    const lines = [
        `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ''}`,
        'Connection: close',
        'Content-Type: application/problem+json',
        `Content-Length: ${String(Buffer.byteLength(body))}`,
        `Cache-Control: ${DEFAULT_CACHE_CONTROL}`,
        ...Object.entries(engineSecurityHeaders()).map(([name, value]) => `${name}: ${value}`),
        ...(result.retryAfterS === undefined ? [] : [`Retry-After: ${String(result.retryAfterS)}`]),
    ];
    socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
}

/**
 * The route types already force an auth mode, a rate limit and strict schemas; what is left is uniqueness, keeping
 * control routes off the tunnel, and a gateway for session routes.
 */
function assertMountable(routes: readonly Route[], deps: HttpAppDeps): void {
    const seen = new Set<string>();
    for (const route of routes) {
        const key = `${route.transport} ${route.method} ${route.path}`;
        if (seen.has(key)) throw new Error(`refusing to mount ${key} twice`);
        seen.add(key);
        if (route.auth === 'control') throw new Error(`refusing to mount control route ${route.path} in the tunnel`);
        if (route.auth === 'session' && deps.sessions === undefined) {
            throw new Error(`refusing to mount session route ${route.path} without a gateway`);
        }
    }
}

/**
 * The engine's HTTP application on the tunnel's TLS connections: a Hono app behind a `node:http` server that never
 * listens, fed one decrypted connection at a time. Routes come only from {@link Route} declarations, so none skips its
 * rate limit or input schema.
 */
export function createHttpApp(deps: HttpAppDeps): HttpApp {
    const { routes, logger } = deps;
    assertMountable(routes, deps);
    const connectionOf = new WeakMap<Socket, SecureConnection>();
    const sockets = new Set<Socket>();
    const app = new Hono<{ Bindings: HttpBindings }>();

    app.use(async (c, next) => {
        await next();
        applySecurityHeaders(c.res.headers);
    });

    function connectionFor(c: Context<{ Bindings: HttpBindings }>): SecureConnection {
        const connection = connectionOf.get(c.env.incoming.socket);
        if (connection === undefined) throw new Error('request on a connection the app did not accept');
        return connection;
    }

    // Before routing, so a forged request learns nothing, not even whether its path exists.
    app.use(async (c, next) => {
        const connection = connectionFor(c);
        if (
            !isSameOriginMutation({
                method: c.req.method,
                hostname: connection.hostname,
                header: (name) => c.req.header(name),
            })
        ) {
            return problemResponse({ code: 'forbidden', extras: { detail: 'Cross-site request refused.' } });
        }
        await next();
        return undefined;
    });

    const httpRoutes = routes.filter((route): route is HttpRoute => route.transport === 'http').sort(bySpecificity);
    for (const route of httpRoutes) {
        app.on(route.method, honoPath(route.path), async (c) => {
            const connection = connectionFor(c);
            const limited = rateLimited(route, deps.rateLimiter, connection.clientIp);
            if (limited !== null) return problemResponse(limited);
            let actor: Actor | null = null;
            if (route.auth === 'session' && deps.sessions !== undefined) {
                const outcome = authenticate(deps.sessions, {
                    method: c.req.method,
                    path: c.req.path,
                    target: requestTarget(c.req.url),
                    hostname: connection.hostname,
                    header: (name) => c.req.header(name),
                    clientIp: connection.clientIp,
                });
                if (outcome.kind === 'refused') return outcome.response;
                actor = outcome.actor;
            }
            const run = (): Promise<Response> =>
                runHttpRoute(route, {
                    request: c.req.raw,
                    params: c.req.param(),
                    connection,
                    clientIp: connection.clientIp,
                    actor,
                });
            return deps.faults === undefined ? run() : withFaults(deps.faults, c.req.path, c.req.raw.signal, run);
        });
    }
    app.notFound(() => problemResponse({ code: 'not-found' }));
    app.onError((error) => {
        logger.error('http.error', { problem: error.name });
        return problemResponse({ code: 'internal-error' });
    });

    const webSockets = new Map<string, { readonly route: WebSocketRoute; readonly server: WebSocketServer }>(
        routes
            .filter((route): route is WebSocketRoute => route.transport === 'websocket')
            .map((route) => [
                route.path,
                {
                    route,
                    server: new WebSocketServer({
                        noServer: true,
                        maxPayload: route.maxPayloadBytes,
                        // Compression would skew the throughput the spike measures and costs memory per socket.
                        perMessageDeflate: false,
                    }),
                },
            ]),
    );

    // Not overriding the global Request and Response keeps the process's fetch types untouched.
    const listener = getRequestListener(app.fetch, { overrideGlobalObjects: false });
    const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
        listener(request, response).catch(() => response.destroy());
    });
    server.timeout = SOCKET_IDLE_TIMEOUT_MS;
    server.on('clientError', (_error, socket: Duplex) => {
        socket.destroy();
    });
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        socket.on('error', () => undefined);
        const connection = connectionOf.get(request.socket);
        const url = URL.parse(request.url ?? '', 'https://engine.invalid');
        const target = url === null ? undefined : webSockets.get(url.pathname);
        if (connection === undefined || url === null || target === undefined || request.method !== 'GET') {
            rejectUpgrade(socket, { code: 'not-found' });
            return;
        }
        const limited = rateLimited(target.route, deps.rateLimiter, connection.clientIp);
        if (limited !== null) {
            rejectUpgrade(socket, limited);
            return;
        }
        const admitted = admitQueryAndHeaders(target.route, url, (name) => {
            const value = request.headers[name];
            return typeof value === 'string' ? value : undefined;
        });
        if (!('kind' in admitted)) {
            rejectUpgrade(socket, admitted);
            return;
        }
        target.server.handleUpgrade(request, socket, head, (ws) => {
            ws.on('error', () => undefined);
            target.route.handle(ws, {
                query: admitted.query,
                headers: admitted.headers,
                connection,
            } as Parameters<WebSocketRoute['handle']>[1]);
        });
    });

    return {
        routes,
        serve(socket, connection) {
            connectionOf.set(socket, connection);
            sockets.add(socket);
            socket.once('close', () => sockets.delete(socket));
            server.emit('connection', socket);
        },
        connections: () => sockets.size,
        close() {
            for (const { server: wss } of webSockets.values()) {
                for (const client of wss.clients) client.terminate();
            }
            for (const socket of [...sockets]) socket.destroy();
        },
    };
}
