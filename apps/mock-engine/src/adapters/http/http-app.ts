import type { IncomingMessage } from 'node:http';
import { STATUS_CODES, createServer } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

import type { HttpBindings } from '@hono/node-server';
import { getRequestListener } from '@hono/node-server';
import type { ProblemCode, ProblemExtras } from '@ptbk/engine-api';
import { ENGINE_UI_CSP, createProblem } from '@ptbk/engine-api';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';

import type { Logger } from '../../domain/logger';
import type { RateLimiter } from '../../domain/rate-limit/rate-limiter';
import type { SecureConnection } from '../tls-stream-server';
import type { HttpRoute, Route, StringFields, WebSocketRoute } from './route';

/** An idle connection (including a paused download) is closed after this long. */
export const SOCKET_IDLE_TIMEOUT_MS = 120_000;
const MAX_HEADER_BYTES = 16 * 1024;

/**
 * Sent on every response. The full security header set is M-05's; the CSP is the engine's exact UI policy, so
 * anything a browser loads from here already runs under it.
 */
export const BASELINE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': ENGINE_UI_CSP,
});

export interface HttpAppDeps {
    readonly routes: readonly Route[];
    readonly rateLimiter: RateLimiter;
    readonly logger: Logger;
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

type ProblemResult =
    | { readonly kind: 'ok'; readonly query: unknown; readonly headers: unknown }
    | {
          readonly kind: 'problem';
          readonly code: ProblemCode;
          readonly extras?: ProblemExtras;
          readonly retryAfterS?: number;
      };

function problemJson(code: ProblemCode, extras: ProblemExtras = {}): string {
    return JSON.stringify(createProblem(code, extras));
}

function problemResponse(result: Extract<ProblemResult, { kind: 'problem' }>): Response {
    const problem = createProblem(result.code, result.extras);
    const headers = new Headers({ 'Content-Type': 'application/problem+json' });
    if (result.retryAfterS !== undefined) headers.set('Retry-After', String(result.retryAfterS));
    return new Response(JSON.stringify(problem), { status: problem.status, headers });
}

/** Repeated parameters are refused outright: a schema should never have to choose between two values. */
function queryOf(url: URL): Record<string, string> | null {
    const query: Record<string, string> = {};
    for (const [name, value] of url.searchParams) {
        if (Object.hasOwn(query, name)) return null;
        query[name] = value;
    }
    return query;
}

function headersOf(schema: StringFields, read: (name: string) => string | undefined): Record<string, string> {
    return Object.fromEntries(
        Object.keys(schema.shape).flatMap((name) => {
            const value = read(name);
            return value === undefined ? [] : [[name, value]];
        }),
    );
}

/** Runs the safeguards every route declares, in order: rate limit, then strict input. */
function admit(
    route: Route,
    deps: HttpAppDeps,
    connection: SecureConnection,
    url: URL,
    readHeader: (name: string) => string | undefined,
): ProblemResult {
    const decision = deps.rateLimiter.consume(route.rateLimit, connection.clientIp);
    if (decision.kind === 'limited') {
        return {
            kind: 'problem',
            code: 'rate-limited',
            retryAfterS: Math.max(1, Math.ceil(decision.retryAfterMs / 1000)),
        };
    }
    const raw = queryOf(url);
    const query = raw === null ? null : route.query.safeParse(raw);
    if (query?.success !== true) {
        return { kind: 'problem', code: 'validation-failed', extras: { detail: 'invalid query parameters' } };
    }
    if (route.headers === null) return { kind: 'ok', query: query.data, headers: null };
    const headers = route.headers.safeParse(headersOf(route.headers, readHeader));
    if (!headers.success) {
        return { kind: 'problem', code: 'validation-failed', extras: { detail: 'invalid request headers' } };
    }
    return { kind: 'ok', query: query.data, headers: headers.data };
}

function rejectUpgrade(socket: Duplex, result: Extract<ProblemResult, { kind: 'problem' }>): void {
    const body = problemJson(result.code, result.extras);
    const status = createProblem(result.code).status;
    const lines = [
        `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ''}`,
        'Connection: close',
        'Content-Type: application/problem+json',
        `Content-Length: ${String(Buffer.byteLength(body))}`,
        ...Object.entries(BASELINE_HEADERS).map(([name, value]) => `${name}: ${value}`),
        ...(result.retryAfterS === undefined ? [] : [`Retry-After: ${String(result.retryAfterS)}`]),
    ];
    socket.end(`${lines.join('\r\n')}\r\n\r\n${body}`);
}

/** The route types already force an auth mode, a rate limit and strict schemas; what is left is uniqueness. */
function assertMountable(routes: readonly Route[]): void {
    const seen = new Set<string>();
    for (const route of routes) {
        const key = `${route.transport} ${route.path}`;
        if (seen.has(key)) throw new Error(`refusing to mount ${key} twice`);
        seen.add(key);
    }
}

/**
 * The engine's HTTP application on the tunnel's TLS connections: a Hono app behind a `node:http` server that never
 * listens, fed one decrypted connection at a time. Routes come only from {@link Route} declarations, so none skips its
 * rate limit or input schema.
 */
export function createHttpApp(deps: HttpAppDeps): HttpApp {
    const { routes, logger } = deps;
    assertMountable(routes);
    const connectionOf = new WeakMap<Socket, SecureConnection>();
    const sockets = new Set<Socket>();
    const app = new Hono<{ Bindings: HttpBindings }>();

    app.use(async (c, next) => {
        await next();
        for (const [name, value] of Object.entries(BASELINE_HEADERS)) c.res.headers.set(name, value);
    });

    function connectionFor(c: Context<{ Bindings: HttpBindings }>): SecureConnection {
        const connection = connectionOf.get(c.env.incoming.socket);
        if (connection === undefined) throw new Error('request on a connection the app did not accept');
        return connection;
    }

    for (const route of routes) {
        if (route.transport !== 'http') continue;
        const httpRoute: HttpRoute = route;
        app.get(httpRoute.path, async (c) => {
            const connection = connectionFor(c);
            const admitted = admit(httpRoute, deps, connection, new URL(c.req.url), (name) => c.req.header(name));
            if (admitted.kind === 'problem') return problemResponse(admitted);
            return httpRoute.handle({
                query: admitted.query,
                headers: admitted.headers,
                connection,
                signal: c.req.raw.signal,
            } as Parameters<HttpRoute['handle']>[0]);
        });
    }
    app.notFound(() => problemResponse({ kind: 'problem', code: 'not-found' }));
    app.onError((error) => {
        logger.error('http.error', { problem: error.name });
        return problemResponse({ kind: 'problem', code: 'internal-error' });
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
            rejectUpgrade(socket, { kind: 'problem', code: 'not-found' });
            return;
        }
        const admitted = admit(target.route, deps, connection, url, (name) => {
            const value = request.headers[name];
            return typeof value === 'string' ? value : undefined;
        });
        if (admitted.kind === 'problem') {
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
