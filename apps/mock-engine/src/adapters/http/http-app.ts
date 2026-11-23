import type { IncomingMessage } from 'node:http';
import { STATUS_CODES, createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import type { HttpBindings } from '@hono/node-server';
import { getRequestListener } from '@hono/node-server';
import { createProblem } from '@ptbk/engine-api';
import type { ProblemDetails } from '@ptbk/engine-api';
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
import { authenticate, isOwnOrigin, isSameOriginMutation, requestTarget } from './gateway-middleware';
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
export function applySecurityHeaders(headers: Headers, microphone = false): void {
    for (const [name, value] of Object.entries(engineSecurityHeaders({ microphone }))) headers.set(name, value);
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
    /** Whether `Permissions-Policy` allows the microphone for the engine's origin: while it advertises `voice-input@1`. */
    readonly microphone?: () => boolean;
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

function rejectUpgrade(socket: Duplex, body: ProblemDetails, microphone: boolean, retryAfterS?: number): void {
    const text = JSON.stringify(body);
    const lines = [
        `HTTP/1.1 ${String(body.status)} ${STATUS_CODES[body.status] ?? ''}`,
        'Connection: close',
        'Content-Type: application/problem+json',
        `Content-Length: ${String(Buffer.byteLength(text))}`,
        `Cache-Control: ${DEFAULT_CACHE_CONTROL}`,
        ...Object.entries(engineSecurityHeaders({ microphone })).map(([name, value]) => `${name}: ${value}`),
        ...(retryAfterS === undefined ? [] : [`Retry-After: ${String(retryAfterS)}`]),
    ];
    socket.end(`${lines.join('\r\n')}\r\n\r\n${text}`);
}

function rejectUpgradeWith(socket: Duplex, problem: Problem, microphone: boolean): void {
    rejectUpgrade(socket, createProblem(problem.code, problem.extras), microphone, problem.retryAfterS);
}

/** The `{name}` segments of `template` in `pathname`, still percent-encoded, or `null` if it does not match. */
function matchPath(template: string, pathname: string): Record<string, string> | null {
    const expected = template.split('/');
    const actual = pathname.split('/');
    if (expected.length !== actual.length) return null;
    const params = Object.create(null) as Record<string, string>;
    for (const [index, segment] of expected.entries()) {
        const value = actual[index] ?? '';
        const name = /^\{(\w+)\}$/.exec(segment)?.[1];
        if (name === undefined) {
            if (segment !== value) return null;
        } else {
            if (value === '') return null;
            params[name] = value;
        }
    }
    return params;
}

/** Whether `Sec-WebSocket-Protocol` lists `protocol`; the header is a comma-separated token list. */
function offers(header: string | undefined, protocol: string): boolean {
    return header?.split(',').some((offered) => offered.trim() === protocol) ?? false;
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
    const microphone = deps.microphone ?? (() => false);
    assertMountable(routes, deps);
    const connectionOf = new WeakMap<Socket, SecureConnection>();
    const sockets = new Set<Socket>();
    const app = new Hono<{ Bindings: HttpBindings }>();

    app.use(async (c, next) => {
        await next();
        applySecurityHeaders(c.res.headers, microphone());
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

    const webSockets = routes
        .filter((route): route is WebSocketRoute => route.transport === 'websocket')
        .map((route) => ({
            route,
            server: new WebSocketServer({
                noServer: true,
                maxPayload: route.maxPayloadBytes,
                // Compression would skew the throughput the spike measures and costs memory per socket.
                perMessageDeflate: false,
                handleProtocols: () => route.subprotocol ?? false,
            }),
        }));
    const webSocketFor = (pathname: string) => {
        for (const target of webSockets) {
            const params = matchPath(target.route.path, pathname);
            if (params !== null) return { ...target, params };
        }
        return undefined;
    };

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
        const target = url === null ? undefined : webSocketFor(url.pathname);
        if (connection === undefined || url === null || target === undefined || request.method !== 'GET') {
            rejectUpgradeWith(socket, { code: 'not-found' }, microphone());
            return;
        }
        const { route } = target;
        const limited = rateLimited(route, deps.rateLimiter, connection.clientIp);
        if (limited !== null) {
            rejectUpgradeWith(socket, limited, microphone());
            return;
        }
        const header = (name: string): string | undefined => {
            const value = request.headers[name];
            return typeof value === 'string' ? value : undefined;
        };
        // A malformed ID names no session, so it is as unknown as any other: 404, never a validation error.
        const params = route.params === null ? null : route.params.safeParse(target.params);
        if (params?.success === false) {
            rejectUpgradeWith(socket, { code: 'not-found' }, microphone());
            return;
        }
        const admitted = admitQueryAndHeaders(route, url, header);
        if (!('kind' in admitted)) {
            rejectUpgradeWith(socket, admitted, microphone());
            return;
        }
        let actor: Actor | null = null;
        if (route.auth === 'session') {
            // A browser sends cookies with a cross-site WebSocket too, and no CORS stops one: only `Origin` does.
            if (!isOwnOrigin({ hostname: connection.hostname, header })) {
                rejectUpgradeWith(
                    socket,
                    { code: 'forbidden', extras: { detail: 'Cross-site request refused.' } },
                    microphone(),
                );
                return;
            }
            const outcome =
                deps.sessions === undefined
                    ? null
                    : authenticate(deps.sessions, {
                          method: 'GET',
                          path: url.pathname,
                          target: `${url.pathname}${url.search}`,
                          hostname: connection.hostname,
                          header,
                          clientIp: connection.clientIp,
                      });
            if (outcome?.kind !== 'signed-in') {
                rejectUpgradeWith(socket, { code: 'unauthenticated' }, microphone());
                return;
            }
            actor = outcome.actor;
            if (route.permission !== null && !actor.permissions.has(route.permission)) {
                rejectUpgradeWith(
                    socket,
                    { code: 'forbidden', extras: { requiredPermission: route.permission } },
                    microphone(),
                );
                return;
            }
        }
        if (route.subprotocol !== null && !offers(header('sec-websocket-protocol'), route.subprotocol)) {
            rejectUpgradeWith(
                socket,
                {
                    code: 'validation-failed',
                    extras: {
                        errors: [{ path: 'headers.sec-websocket-protocol', message: `Offer ${route.subprotocol}.` }],
                    },
                },
                microphone(),
            );
            return;
        }
        const admission = route.handle({
            params: params?.data ?? null,
            query: admitted.query,
            headers: admitted.headers,
            connection,
            actor,
            clientIp: connection.clientIp,
        } as Parameters<WebSocketRoute['handle']>[0]);
        if (admission.kind === 'refuse') {
            rejectUpgrade(socket, admission.problem, microphone());
            return;
        }
        const handshake = { completed: false };
        // Synchronous: `ws` either completes the handshake and calls back, or answers 400 and destroys the socket.
        target.server.handleUpgrade(request, socket, head, (ws) => {
            handshake.completed = true;
            ws.on('error', () => undefined);
            admission.open(ws);
        });
        if (!handshake.completed) admission.abandoned?.();
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
            for (const { server: wss } of webSockets) {
                for (const client of wss.clients) client.terminate();
            }
            for (const socket of [...sockets]) socket.destroy();
        },
    };
}
